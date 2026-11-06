import { randomBytes, randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createBoardWidgetContentFields,
  parseManifest,
  serializeManifest,
} from "../boards/sqlite-board-codec.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  listExistingAgentDatabaseTargets,
  resolveTargetSqliteOptions,
} from "../infra/session-sqlite-migration-readers.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { escapeHtml } from "../shared/html-escape.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";

function readLegacyRecord(json: string | null) {
  if (json === null) {
    return undefined;
  }
  try {
    return asOptionalRecord(JSON.parse(json));
  } catch {
    // Unrelated malformed widget data stays with its existing repair owner.
    return undefined;
  }
}

function listLegacyWidgets(database: EngineConnection) {
  const db = getNodeSqliteKysely<Pick<DB, "board_widgets">>(database);
  return executeSqliteQuerySync(
    database,
    db
      .selectFrom("board_widgets")
      .select(["session_key", "name", "content_kind", "revision", "descriptor_json", "manifest"]),
  ).rows.flatMap((row) => {
    const descriptor = readLegacyRecord(row.descriptor_json);
    const metadata = readLegacyRecord(row.manifest);
    const retire =
      descriptor?.pluginKind === "canvas:a2ui" || metadata?.registeredContentKind === "a2ui";
    return retire ||
      metadata?.contentOwner === "registered" ||
      (row.content_kind === "plugin" && typeof descriptor?.source === "string")
      ? [{ ...row, descriptor, metadata, retire }]
      : [];
  });
}

function createRetiredWidgetPreview(row: ReturnType<typeof listLegacyWidgets>[number]) {
  const kind =
    typeof row.descriptor?.pluginKind === "string" ? row.descriptor.pluginKind : "unknown";
  const source =
    typeof row.descriptor?.source === "string"
      ? row.descriptor.source
      : (row.descriptor_json ?? "");
  return `<article><h1>Retired ${escapeHtml(kind)} widget</h1>
<p>This widget renderer was removed. Its saved source is preserved below and can be recreated as an HTML widget.</p>
<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(source)}</pre>
<details><summary>Original widget data</summary>
<h2>Descriptor</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(row.descriptor_json ?? "")}</pre>
<h2>Manifest</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(row.manifest)}</pre>
</details></article>`;
}

/** Retire A2UI and preserve other removed renderers as inert HTML before canonical board reads. */
export async function retireDoctorA2uiWidgets(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  integrityCheck?: "quick" | "full";
}): Promise<MigrationMessages> {
  const result: MigrationMessages = {
    changes: [],
    warnings: [],
    warningDisposition: "recoverable",
  };
  const targets = listExistingAgentDatabaseTargets(params.cfg, params.env);
  const pending = targets.filter((target) => {
    try {
      const inspected = withOpenClawAgentDatabaseReadOnly(
        (database) => listLegacyWidgets(database.db).length,
        resolveTargetSqliteOptions(target, params.env),
      );
      return inspected.found && inspected.value > 0;
    } catch (error) {
      result.warnings.push(
        `Could not inspect retired board widgets in agent ${target.agentId}: ${formatErrorMessage(error)}. Run openclaw doctor --fix after resolving the database warning.`,
      );
      return false;
    }
  });
  if (pending.length === 0) {
    return result;
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    throw new Error("A2UI widget retirement requires Doctor maintenance ownership.");
  }
  maintenance.assertAdmission();
  const backup = await backupDoctorMigrationDatabases({
    env: params.env,
    pendingDatabasePaths: pending.map((target) => target.sqlitePath),
    databasePaths: targets.map((target) => target.sqlitePath),
    check: params.integrityCheck,
    // A same-version Doctor backup can predate newly created widgets.
    repair: { key: `retire-a2ui-widgets:${randomUUID()}` },
  });
  result.changes.push(...backup.changes);
  result.warnings.push(...backup.warnings);
  maintenance.assertAdmission();
  let removed = 0;
  let converted = 0;
  for (const target of pending) {
    const wasOpen = isOpenClawAgentDatabaseOpen(target.sqlitePath);
    try {
      const migrated = runOpenClawAgentWriteTransaction(
        (database) => {
          maintenance.assertAdmission();
          const rows = listLegacyWidgets(database.db);
          const db = getNodeSqliteKysely<Pick<DB, "board_widgets">>(database.db);
          for (const row of rows) {
            if (row.retire) {
              executeSqliteQuerySync(
                database.db,
                db
                  .deleteFrom("board_widgets")
                  .where("session_key", "=", row.session_key)
                  .where("name", "=", row.name),
              );
              continue;
            }
            const manifest = parseManifest(
              JSON.stringify({
                ...row.metadata,
                contentOwner: "html",
                netOrigins: undefined,
                tools: undefined,
              }),
            );
            const fields = createBoardWidgetContentFields(
              {
                sessionKey: row.session_key,
                name: row.name,
                content: { kind: "html", html: createRetiredWidgetPreview(row) },
              },
              manifest,
              row.revision + 1,
              "none",
              randomBytes(16).toString("hex"),
              Date.now(),
            );
            fields.manifest = serializeManifest(
              { contentOwner: "html" },
              undefined,
              "none",
              undefined,
              manifest,
              manifest.nameIdentity?.kind !== "invalid" ? manifest.nameIdentity : undefined,
            );
            executeSqliteQuerySync(
              database.db,
              db
                .updateTable("board_widgets")
                .set(fields)
                .where("session_key", "=", row.session_key)
                .where("name", "=", row.name),
            );
          }
          return {
            removed: rows.filter((row) => row.retire).length,
            converted: rows.filter((row) => !row.retire).length,
          };
        },
        resolveTargetSqliteOptions(target, params.env),
        { operationLabel: "doctor.retire-a2ui-widgets" },
      );
      removed += migrated.removed;
      converted += migrated.converted;
    } finally {
      if (!wasOpen) {
        await closeOpenClawAgentDatabaseByPathAsync(target.sqlitePath);
      }
    }
    maintenance.assertAdmission();
  }
  if (removed > 0) {
    result.warnings.push(
      `Deleted ${removed} stored widget(s) after backup. A2UI widgets were retired and can be recreated as HTML widgets.`,
    );
  }
  if (converted > 0) {
    result.warnings.push(
      `Converted ${converted} other retired widget(s) to inert HTML source previews after backup. Original source and widget metadata were preserved; previous capabilities were removed.`,
    );
  }
  return result;
}

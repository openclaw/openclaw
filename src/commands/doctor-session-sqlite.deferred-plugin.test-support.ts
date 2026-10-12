import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { recordLegacyMigrationRun } from "../infra/state-migrations.receipts.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

export async function seedStaleDeferredPluginSessionImport(state: OpenClawTestState) {
  const fixture = await seedDeferredPluginSessionSource(state, "default", "brave");
  const index = JSON.parse(fs.readFileSync(fixture.storePath, "utf8"));
  for (const key of Object.keys(index)) {
    index[key].updatedAt = Date.now();
  }
  index["agent:main:kept"].acp = {
    backend: "acpx",
    agent: "fixture",
    runtimeSessionName: "legacy-runtime",
    mode: "persistent",
    state: "idle",
    lastActivityAt: 100,
  };
  fs.writeFileSync(fixture.storePath, JSON.stringify(index));
  await runDoctorSessionSqlite({
    cfg: fixture.cfg,
    env: state.env,
    allAgents: true,
    mode: "import",
  });
  let foreignReport = "";
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const row = db
        .prepare(
          "SELECT report_json FROM migration_sources WHERE migration_kind = 'deferred-plugin-session-import'",
        )
        .get()!;
      foreignReport = JSON.stringify({
        ...JSON.parse(String(row.report_json)),
        databaseIdentity: "123:456",
      });
      db.prepare(
        "UPDATE migration_sources SET report_json = ? WHERE migration_kind = 'deferred-plugin-session-import'",
      ).run(foreignReport);
    },
    { env: state.env },
  );
  await closeOpenClawAgentDatabasesAsync();
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(fixture.storePath, fixture.scope).path;
  const db = openNodeSqliteDatabase(sqlitePath);
  try {
    db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run("legacy-kept");
    db.prepare("DELETE FROM session_windows WHERE session_id = ?").run("legacy-kept");
    db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run("agent:main:kept");
  } finally {
    db.close();
  }
  return { ...fixture, foreignReport, sqlitePath };
}

export async function editAndDeleteImportedSessions(
  scope: Awaited<ReturnType<typeof seedDeferredPluginSessionSource>>["scope"],
  keptLabel: string,
) {
  // Retention of the fixture's old timestamps must not race its intended deletion.
  await expect(
    patchSessionEntryCore(
      { ...scope, sessionKey: "agent:main:kept" },
      () => ({ label: keptLabel }),
      { skipMaintenance: true },
    ),
  ).resolves.toMatchObject({ label: keptLabel });
  await expect(
    deleteSessionEntryLifecycle({
      ...scope,
      target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    }),
  ).resolves.toMatchObject({ deleted: true });
}

/** Inject competing work inside synchronous publication callbacks. */
export function seedConcurrentDeferredPluginMigration(state: OpenClawTestState, pluginId: string) {
  const previous = readDeferredPluginMigrations({ env: state.env }).find(
    (pending) => pending.pluginId === pluginId,
  );
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      recordLegacyMigrationRun(db, {
        runId: `deferred-plugin-migration:${pluginId}`,
        startedAt: 1,
        finishedAt: null,
        status: "pending",
        reportJson: JSON.stringify({
          ...previous,
          pluginId,
          reason: "A concurrent Doctor found additional migration work.",
          command: "openclaw doctor --fix",
          requiresStateMigration: true,
        }),
        upsert: true,
      }),
    { env: state.env },
  );
}

export async function seedDeferredPluginSessionSource(
  state: OpenClawTestState,
  layout: "external" | "default" | "legacy-root" = "external",
  pluginId = "fixture-plugin",
  missingTranscript?: "declared" | "metadata-only",
) {
  // This fixture models active legacy stores with known deletion history.
  openOpenClawStateDatabase({ env: state.env });
  const sessionsDir =
    layout === "external"
      ? path.join(state.root, "external-sessions")
      : layout === "default"
        ? state.sessionsDir("main")
        : state.statePath("sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  const records = Object.fromEntries(
    ["kept", "deleted", ...(missingTranscript ? ["missing"] : [])].map((name) => {
      const sessionId = `legacy-${name}`;
      const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
      if (name === "missing") {
        return [
          `agent:main:${name}`,
          {
            sessionId,
            ...(missingTranscript === "declared" ? { sessionFile: path.basename(transcript) } : {}),
            updatedAt: 20,
          },
        ];
      }
      fs.writeFileSync(
        transcript,
        [
          { type: "session", version: 3, id: sessionId },
          {
            type: "message",
            id: `${name}-message`,
            parentId: null,
            message: { role: "user", content: name },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      fs.writeFileSync(
        `${transcript}.${pluginId === "codex" ? "codex-app-server" : pluginId}.json`,
        JSON.stringify({
          schemaVersion: 2,
          threadId: name,
          sessionFile: transcript,
          updatedAt: "2026-01-01T00:00:00.000Z",
          pluginAppPolicyContext: { fingerprint: "policy-1", apps: {}, pluginAppIds: {} },
        }),
      );
      return [
        `agent:main:${name}`,
        { sessionId, sessionFile: path.basename(transcript), updatedAt: 20 },
      ];
    }),
  );
  fs.writeFileSync(storePath, JSON.stringify(records));
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    ...(layout === "external" ? { session: { store: storePath } } : {}),
  };
  await recordDeferredPluginMigrations({
    env: state.env,
    pending: [
      {
        pluginId,
        reason: "The configured plugin is not installed.",
        command:
          pluginId === "codex"
            ? "openclaw plugins install @openclaw/codex"
            : "openclaw plugins install @example/fixture-plugin",
        ...(layout === "external" ? { configPaths: [["session", "store"]] } : {}),
      },
    ],
  });
  const originals = new Map(
    fs.readdirSync(sessionsDir).map((name) => {
      const file = path.join(sessionsDir, name);
      return [file, fs.readFileSync(file)];
    }),
  );
  const scope = {
    agentId: "main",
    env: state.env,
    storePath:
      layout === "legacy-root" ? path.join(state.sessionsDir("main"), "sessions.json") : storePath,
  };
  return { cfg, storePath, originals, scope };
}

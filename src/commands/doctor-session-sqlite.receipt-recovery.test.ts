import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import { readSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

function receipt(env: NodeJS.ProcessEnv) {
  const row = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      db
        .prepare(
          "SELECT report_json FROM migration_sources WHERE migration_kind = 'deferred-plugin-session-import'",
        )
        .get(),
    { env },
  );
  return JSON.parse(String(row?.report_json)) as {
    databaseIdentity: string;
    sources: Array<{ path: string; identity: ReturnType<typeof readMigrationArtifactIdentity> }>;
  };
}

describe("retained session receipt recovery", () => {
  it.each([
    { replacement: "index", failedManifest: true },
    { replacement: "database", failedManifest: true },
    { replacement: "index", failedManifest: false },
  ] as const)(
    "recovers verified $replacement content (failed manifest: $failedManifest)",
    async ({ replacement, failedManifest }) => {
      await withOpenClawTestState({ label: "receipt-rebind" }, async (state) => {
        const { cfg, storePath, scope } = seedDeferredPluginSessionSource(
          state,
          "default",
          "brave",
        );
        const imported = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
        const before = receipt(state.env);
        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "Current metadata" },
        );
        closeOpenClawAgentDatabasesForTest();
        const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, scope).path;
        const replaced = replacement === "index" ? storePath : sqlitePath;
        fs.copyFileSync(replaced, `${replaced}.backup`);
        fs.renameSync(`${replaced}.backup`, replaced);
        if (failedManifest) {
          const manifest = readSessionSqliteMigrationManifest(imported.migrationRun!.manifestPath)!;
          manifest.failedAt = new Date().toISOString();
          fs.writeFileSync(imported.migrationRun!.manifestPath, JSON.stringify(manifest));
        }
        expect
          .soft(() => assertSessionStoreMigrationComplete({ cfg, env: state.env }))
          .not.toThrow();
        const recovered = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          agent: "main",
          mode: "recover",
        });
        expect(recovered.targets.flatMap((target) => target.issues)).not.toContainEqual(
          expect.objectContaining({ code: "retained_plugin_source_conflict" }),
        );
        const after = receipt(state.env);
        const currentIndex = readMigrationArtifactIdentity(storePath);
        expect(after.sources.find((source) => source.path === storePath)?.identity).toEqual(
          currentIndex,
        );
        const database = fs.statSync(sqlitePath, { bigint: true });
        expect(after.databaseIdentity).toBe(`${database.dev}:${database.ino}`);
        expect(after).not.toEqual(before);
        expect(recovered.totals.validatedTranscriptEvents).toBe(4);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("Current metadata");
        recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["brave"],
        });
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        expect(fs.existsSync(path.join(path.dirname(storePath), "legacy-kept.jsonl"))).toBe(true);
      });
    },
  );
  it.each(["missing", "reordered"] as const)(
    "protects retained history when replacement events are %s",
    async (change) => {
      await withOpenClawTestState({ label: "receipt-incomplete-database" }, async (state) => {
        const { cfg, storePath, scope } = seedDeferredPluginSessionSource(
          state,
          "default",
          "brave",
        );
        const imported = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
        const before = receipt(state.env);
        closeOpenClawAgentDatabasesForTest();
        const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, scope).path;
        fs.copyFileSync(sqlitePath, `${sqlitePath}.replacement`);
        fs.renameSync(`${sqlitePath}.replacement`, sqlitePath);
        const db = openNodeSqliteDatabase(sqlitePath);
        if (change === "missing") {
          db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run("legacy-kept");
        } else {
          db.exec("BEGIN; PRAGMA defer_foreign_keys = ON;");
          db.prepare("UPDATE transcript_events SET seq = seq + 100 WHERE session_id = ?").run(
            "legacy-kept",
          );
          db.prepare("UPDATE transcript_events SET seq = 101 - seq WHERE session_id = ?").run(
            "legacy-kept",
          );
          db.exec("COMMIT;");
        }
        db.close();
        const manifest = readSessionSqliteMigrationManifest(imported.migrationRun!.manifestPath)!;
        manifest.failedAt = new Date().toISOString();
        const historicalIssues = Array.from({ length: 11 }, (_, index) => ({
          code: `retained_failure_${index}`,
          message: `Retained migration finding ${index}`,
        }));
        manifest.targets[0]!.issues.push(...historicalIssues);
        fs.writeFileSync(imported.migrationRun!.manifestPath, JSON.stringify(manifest));
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        const recovered = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          agent: "main",
          mode: "recover",
        });
        expect(recovered.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({
            code: "retained_plugin_source_conflict",
            message: expect.stringContaining("legacy-kept.jsonl"),
          }),
        );
        expect(receipt(state.env)).toEqual(before);
        const jsonReport = JSON.parse(
          fs.readFileSync(recovered.migrationRun!.failureReportJsonPath!, "utf8"),
        ) as { targets: Array<{ issues: Array<{ code: string }> }> };
        const markdownReport = fs.readFileSync(
          recovered.migrationRun!.failureReportMarkdownPath!,
          "utf8",
        );
        for (const issue of [
          ...historicalIssues,
          ...recovered.targets.flatMap((target) => target.issues),
        ]) {
          expect(jsonReport.targets.flatMap((target) => target.issues)).toContainEqual(
            expect.objectContaining({ code: issue.code }),
          );
          expect(markdownReport).toContain(`[${issue.code}]`);
          expect(recovered.supportIssue?.body).toContain(`[${issue.code}]`);
        }
        expect(markdownReport).toContain("doctor recover completed with remaining issues");
        expect(
          fs.readFileSync(recovered.migrationRun!.failureReportMarkdownPath!, "utf8"),
        ).toContain("[retained_plugin_source_conflict]");
        expect(
          fs.readFileSync(recovered.migrationRun!.failureReportMarkdownPath!, "utf8"),
        ).not.toContain("restored and validated");
      });
    },
  );
});

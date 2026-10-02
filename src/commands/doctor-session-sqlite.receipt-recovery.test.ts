import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import * as emptySourceRecovery from "../infra/deferred-plugin-session-empty.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as migrationArtifacts from "../infra/session-sqlite-migration-artifact.js";
import { readSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as transcriptArchives from "./doctor-session-sqlite-archive.js";
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
    sources: Array<{
      path: string;
      identity: ReturnType<typeof migrationArtifacts.readMigrationArtifactIdentity>;
    }>;
  };
}

describe("retained session receipt recovery", () => {
  it.each(["verification", "archive"] as const)(
    "protects newer history when an empty source changes before %s",
    async (phase) => {
      await withOpenClawTestState({ label: "receipt-empty-source-change" }, async (state) => {
        const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(
          state,
          "default",
          "brave",
        );
        const options = { cfg, env: state.env, allAgents: true };
        await runDoctorSessionSqlite({ ...options, mode: "import" });
        const source = path.join(path.dirname(storePath), "legacy-kept.jsonl");
        const bytes = fs.readFileSync(source, "utf8");
        const events = loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" });
        fs.writeFileSync(`${source}.bak-15767-200`, bytes);
        fs.writeFileSync(source, "");
        closeOpenClawAgentDatabasesForTest();
        const db = openNodeSqliteDatabase(
          resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
        );
        db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run("legacy-kept");
        db.close();
        const newer =
          bytes +
          JSON.stringify({
            type: "message",
            id: "newer-message",
            parentId: "kept-message",
            message: { role: "user", content: "Newer retained history" },
          }) +
          "\n";
        let changed = false;
        const recoverEmpty = emptySourceRecovery.recoverEmptyRetainedTranscript;
        const planArchive = transcriptArchives.planSessionJsonlArchiveMove;
        const spy =
          phase === "verification"
            ? vi
                .spyOn(emptySourceRecovery, "recoverEmptyRetainedTranscript")
                .mockImplementation((params) => {
                  if (params.source.originalPath === source) {
                    fs.writeFileSync(source, newer);
                    changed = true;
                  }
                  return recoverEmpty(params);
                })
            : vi
                .spyOn(transcriptArchives, "planSessionJsonlArchiveMove")
                .mockImplementation((params) => {
                  const move = planArchive(params);
                  if (params.sourcePathRaw === source) {
                    fs.writeFileSync(source, newer);
                    changed = true;
                  }
                  return move;
                });
        try {
          await runDoctorSessionSqlite({ ...options, mode: "recover" });
        } finally {
          spy.mockRestore();
        }
        expect(changed).toBe(true);
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toEqual(
          phase === "verification" ? [] : events,
        );
        if (phase === "archive") {
          expect(fs.existsSync(source)).toBe(true);
          expect(fs.readFileSync(source, "utf8")).toBe(newer);
        }
      });
    },
  );
  it.each([
    { backups: true, missingRows: false, indexed: false },
    { backups: true, missingRows: true, indexed: true },
    { backups: false, missingRows: false, indexed: true },
    { backups: false, missingRows: true, indexed: true },
  ])(
    "recovers empty originals (backups: $backups, missing rows: $missingRows, indexed: $indexed)",
    async ({ backups, missingRows, indexed }) => {
      await withOpenClawTestState({ label: "receipt-empty-transcript" }, async (state) => {
        const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(
          state,
          "default",
          "brave",
        );
        const source = path.join(
          path.dirname(storePath),
          indexed && backups ? "named-transcript.jsonl" : "legacy-kept.jsonl",
        );
        if (!indexed || backups) {
          const index = JSON.parse(fs.readFileSync(storePath, "utf8"));
          if (!indexed) {
            delete index["agent:main:kept"];
          } else {
            index["agent:main:kept"].sessionFile = path.basename(source);
            fs.renameSync(path.join(path.dirname(storePath), "legacy-kept.jsonl"), source);
          }
          fs.writeFileSync(storePath, JSON.stringify(index));
        }
        const options = { cfg, env: state.env, allAgents: true };
        await runDoctorSessionSqlite({ ...options, mode: "import" });
        const bytes = fs.readFileSync(source, "utf8");
        const originalEvents = loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" });
        const backupPaths = [`${source}.bak-15767-100`, `${source}.bak-15767-200`];
        if (backups) {
          fs.writeFileSync(backupPaths[0]!, bytes.split("\n")[0]! + "\n");
          fs.writeFileSync(backupPaths[1]!, bytes);
        }
        fs.writeFileSync(source, "");
        closeOpenClawAgentDatabasesForTest();
        const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, scope).path;
        fs.copyFileSync(sqlitePath, `${sqlitePath}.replacement`);
        fs.renameSync(`${sqlitePath}.replacement`, sqlitePath);
        if (missingRows) {
          const db = openNodeSqliteDatabase(sqlitePath);
          db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run("legacy-kept");
          db.close();
        }
        const before = receipt(state.env);
        const recovered = await runDoctorSessionSqlite({ ...options, mode: "recover" });
        const issues = recovered.targets.flatMap((target) => target.issues);
        if (!backups && missingRows) {
          expect(issues).toContainEqual(
            expect.objectContaining({
              code: "retained_plugin_source_conflict",
              message: expect.stringContaining(
                `Restore a complete verified transcript at ${source}`,
              ),
            }),
          );
          expect(issues.map((issue) => issue.message).join("\n")).toContain(sqlitePath);
          expect(fs.readFileSync(source, "utf8")).toBe("");
          expect(receipt(state.env)).toEqual(before);
          return;
        }
        expect(issues).not.toContainEqual(
          expect.objectContaining({ code: "retained_plugin_source_conflict" }),
        );
        expect(issues).toContainEqual(
          expect.objectContaining({ code: "retained_empty_transcript_superseded" }),
        );
        const archives = recovered.targets.flatMap((target) => target.archivedTranscriptFiles);
        expect(archives).toHaveLength(1);
        expect(fs.readFileSync(archives[0]!, "utf8")).toBe("");
        expect(fs.existsSync(source)).toBe(false);
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toEqual(
          originalEvents,
        );
        if (backups) {
          expect(fs.readFileSync(backupPaths[1]!, "utf8")).toBe(bytes);
          expect(issues.map((issue) => issue.message).join("\n")).toContain(backupPaths[1]);
        }
        const again = await runDoctorSessionSqlite({ ...options, mode: "recover" });
        expect(again.targets.flatMap((target) => target.issues)).not.toContainEqual(
          expect.objectContaining({ code: "retained_plugin_source_conflict" }),
        );
      });
    },
  );
  it.each([
    { replacement: "index", failedManifest: true },
    { replacement: "database", failedManifest: true },
    { replacement: "index", failedManifest: false },
  ] as const)(
    "recovers verified $replacement content (failed manifest: $failedManifest)",
    async ({ replacement, failedManifest }) => {
      await withOpenClawTestState({ label: "receipt-rebind" }, async (state) => {
        const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(
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
        const currentIndex = migrationArtifacts.readMigrationArtifactIdentity(storePath);
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
        await recordDeferredPluginMigrations({
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
        const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(
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
        expect(markdownReport).not.toContain("restored and validated");
      });
    },
  );
});

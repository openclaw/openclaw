import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import * as emptySourceRecovery from "../infra/deferred-plugin-session-empty.js";
import type { DeferredPluginSessionImport } from "../infra/deferred-plugin-session-sources.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import * as transcriptArchives from "./doctor-session-sqlite-archive.js";
import { withRetainedSource, expectIssue } from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite, type DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import {
  expectFiles,
  containsObjects,
  expectMissing,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import { expectNoIssue, stateRows, writeState } from "./doctor-session-sqlite.test-support.js";

function receipt(env: NodeJS.ProcessEnv) {
  const rows = stateRows(
    env,
    "SELECT report_json FROM migration_sources WHERE migration_kind = 'deferred-plugin-session-import'",
  );
  return JSON.parse(String(rows?.[0]?.report_json)) as DeferredPluginSessionImport;
}

const withReceipt = (run: Parameters<typeof withRetainedSource>[0]) =>
  withRetainedSource(run, "default", "brave");

it.each(["current", "legacy"] as const)(
  "keeps a %s receipt valid after repeated device-number changes",
  (format) =>
    withReceipt(async ({ state, storePath, scope, run, readEntry }) => {
      await run("import");
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, scope).path;
      const file = fs.statSync(sqlitePath, { bigint: true });
      const before = receipt(state.env);
      if (format === "legacy") {
        const reportJson = JSON.stringify({
          ...before,
          databaseIdentity: `${file.dev + 1n}:${file.ino}`,
        });
        writeState(
          state.env,
          [
            "UPDATE migration_runs SET report_json = ? WHERE id IN (SELECT last_run_id FROM migration_sources WHERE migration_kind = 'deferred-plugin-session-import')",
            reportJson,
          ],
          [
            "UPDATE migration_sources SET report_json = ? WHERE migration_kind = 'deferred-plugin-session-import'",
            reportJson,
          ],
        );
      }
      const lstat = fs.lstatSync;
      let device = file.dev + 2n;
      const reboot = vi.spyOn(fs, "lstatSync").mockImplementation((pathname, statOptions) => {
        const current = lstat(pathname, statOptions);
        if (pathname === sqlitePath && current) {
          Object.defineProperty(current, "dev", { value: device });
        }
        return current;
      });
      try {
        if (format === "current") {
          const validated = await run("validate");
          expectNoIssue(validated, "retained_plugin_source_conflict");
        }
        const repaired = await run("import");
        expectNoIssue(repaired, "retained_plugin_source_conflict");
        const upgraded = receipt(state.env);
        expect(upgraded.sources).toEqual(before.sources);
        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "Current metadata after reboot" },
        );
        device = file.dev + 3n;
        const validated = await run("validate");
        expectNoIssue(validated, "retained_plugin_source_conflict");
        const repeated = await run("import");
        expectNoIssue(repeated, "retained_plugin_source_index_rebuilt");
        expect(receipt(state.env)).toEqual(upgraded);
        expect(upgraded.databaseIdentity).toMatch(new RegExp(`^inode:${file.ino}:birthtime:`));
        expect(repeated.totals).toMatchObject({ importedEntries: 0, importedTranscriptEvents: 0 });
        expect(readEntry("agent:main:kept")?.entry.label).toBe("Current metadata after reboot");
      } finally {
        reboot.mockRestore();
      }
    }),
);
it.each(["verification", "archive"] as const)(
  "protects newer history when an empty source changes before %s",
  (phase) =>
    withReceipt(async ({ storePath, scope, run, file, readEvents }) => {
      await run("import");
      const source = file("legacy-kept.jsonl");
      const bytes = fs.readFileSync(source, "utf8");
      const events = readEvents("legacy-kept");
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
        await run("recover");
      } finally {
        spy.mockRestore();
      }
      expect(changed).toBe(true);
      expect(readEvents("legacy-kept")).toEqual(phase === "verification" ? [] : events);
      if (phase === "archive") {
        expect(fs.existsSync(source)).toBe(true);
        expectFiles(newer, source);
      }
    }),
);
it("recovers an empty unindexed original from its retained backups", () =>
  withReceipt(async ({ storePath, run, file, readEvents }) => {
    const source = file("legacy-kept.jsonl");
    const index = JSON.parse(fs.readFileSync(storePath, "utf8"));
    delete index["agent:main:kept"];
    fs.writeFileSync(storePath, JSON.stringify(index));
    await run("import");
    const bytes = fs.readFileSync(source, "utf8");
    const originalEvents = readEvents("legacy-kept");
    const backupPaths = [`${source}.bak-15767-100`, `${source}.bak-15767-200`];
    fs.writeFileSync(backupPaths[0]!, bytes.split("\n")[0]! + "\n");
    fs.writeFileSync(backupPaths[1]!, bytes);
    fs.writeFileSync(source, "");
    const recovered = await run("recover");
    const issues = recovered.targets.flatMap((target) => target.issues);
    expect(issues).not.toContainEqual(
      expect.objectContaining({ code: "retained_plugin_source_conflict" }),
    );
    containsObjects(issues, { code: "retained_empty_transcript_superseded" });
    const archives = recovered.targets.flatMap((target) => target.archivedTranscriptFiles);
    expect(archives).toHaveLength(1);
    expectFiles("", archives[0]!);
    expectMissing(source);
    expect(readEvents("legacy-kept")).toEqual(originalEvents);
    expectFiles(bytes, backupPaths[1]!);
    expect(issues.map((issue) => issue.message).join("\n")).toContain(backupPaths[1]);
    const again = await run("recover");
    expectNoIssue(again, "retained_plugin_source_conflict");
  }));
it("reports missing history while superseding a foreign empty-source receipt", () =>
  withReceipt(async ({ state, storePath, scope, run, file, readEvents }) => {
    await run("import");
    const source = file("legacy-kept.jsonl");
    fs.writeFileSync(source, "");
    closeOpenClawAgentDatabasesForTest();
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, scope).path;
    fs.copyFileSync(sqlitePath, `${sqlitePath}.replacement`);
    fs.renameSync(`${sqlitePath}.replacement`, sqlitePath);
    const db = openNodeSqliteDatabase(sqlitePath);
    db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run("legacy-kept");
    db.close();
    const before = receipt(state.env);

    const recovered = await run("recover");
    const issues = recovered.targets.flatMap((target) => target.issues);
    containsObjects(issues, {
      code: "historical_transcript_deferred",
      message: expect.stringContaining(source),
    });
    expect(issues.map((issue) => issue.message).join("\n")).toContain(sqlitePath);
    expect(recovered.totals.archivedTranscriptFiles).toBe(0);
    expectFiles("", source);
    expect(readEvents("legacy-kept")).toEqual([]);
    expect(receipt(state.env)).toMatchObject({ ...before, superseded: "different-database" });
  }));
it("protects retained history when replacement events are reordered", () =>
  withReceipt(async ({ state, cfg, storePath, scope, run, readEvents }) => {
    const imported = await run("import");
    const before = receipt(state.env);
    closeOpenClawAgentDatabasesForTest();
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, scope).path;
    fs.copyFileSync(sqlitePath, `${sqlitePath}.replacement`);
    fs.renameSync(`${sqlitePath}.replacement`, sqlitePath);
    const db = openNodeSqliteDatabase(sqlitePath);

    db.exec("BEGIN; PRAGMA defer_foreign_keys = ON;");
    db.prepare("UPDATE transcript_events SET seq = seq + 100 WHERE session_id = ?").run(
      "legacy-kept",
    );
    db.prepare("UPDATE transcript_events SET seq = 101 - seq WHERE session_id = ?").run(
      "legacy-kept",
    );
    db.exec("COMMIT;");

    db.close();
    const reordered = readEvents("legacy-kept");
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
    expectIssue(recovered, {
      code: "retained_plugin_receipt_superseded",
    });
    expect(readEvents("legacy-kept")).toEqual(reordered);
    const superseded = stateRows(
      state.env,
      "SELECT report_json FROM migration_runs WHERE status = 'superseded'",
    )?.[0];
    expect(JSON.parse(String(superseded?.report_json))).toMatchObject({ receipt: before });
    const jsonReport = JSON.parse(
      fs.readFileSync(recovered.migrationRun!.failureReportJsonPath!, "utf8"),
    ) as DoctorSessionSqliteReport;
    const markdownReport = fs.readFileSync(
      recovered.migrationRun!.failureReportMarkdownPath!,
      "utf8",
    );
    for (const issue of [
      ...historicalIssues,
      ...recovered.targets.flatMap((target) => target.issues),
    ]) {
      expectIssue(jsonReport, { code: issue.code });
      expect(markdownReport).toContain(`[${issue.code}]`);
      expect(recovered.supportIssue?.body).toContain(`[${issue.code}]`);
    }
    expect(markdownReport).toContain("doctor recover completed with remaining issues");
    expect(markdownReport).not.toContain("restored and validated");
  }));

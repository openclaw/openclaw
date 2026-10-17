import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import {
  hasDeferredPluginSessionImport,
  readDeferredPluginSessionImport,
} from "../infra/deferred-plugin-session-sources.js";
import { databaseIdentity } from "../infra/deferred-plugin-session-verification.js";
import * as directoryDurability from "../infra/directory-durability.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { editAndDeleteImportedSessions } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import {
  messageEvent,
  expectIssue,
  seedRetainedSource,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import {
  expectMissing,
  expectFiles,
  containsObjects,
} from "./doctor-session-sqlite.publication-spies.test-support.js";

afterEach(() => vi.restoreAllMocks());

type SessionScope = Awaited<ReturnType<typeof seedRetainedSource>>["scope"];

function expectCanonicalSessions(scope: SessionScope, label: string) {
  expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(
    label,
  );
  expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
}

function reactivateArchivedReceipt(env: NodeJS.ProcessEnv) {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        "UPDATE migration_sources SET removed_source = 0 WHERE migration_kind = 'deferred-plugin-session-import'",
      ).run();
    },
    { env },
  );
}

function completePluginMigration(env: NodeJS.ProcessEnv) {
  return recordDeferredPluginMigrations({
    env,
    pending: [],
    resolvedPluginIds: ["fixture-plugin"],
  });
}

describe("deferred plugin session receipt retirement", () => {
  it.each([
    ["missing", false, "retained_plugin_source_conflict"],
    ["changed", false, "retained_plugin_source_conflict"],
    ["missing", true, "historical_transcript_deferred"],
    ["changed", true, "historical_transcript_deferred"],
  ] as const)(
    "keeps a receipt active when its archived transcript is %s (leftover pointer: %s)",
    async (damage, leftoverPointer, issueCode) => {
      await withOpenClawTestState({ label: "deferred-damaged-archive" }, async (state) => {
        const { cfg, scope, run, readEvents } = await seedRetainedSource(state, "default");
        const pointer = path.join(state.sessionsDir("main"), "legacy-kept.trajectory-path.json");
        const pointerBytes = JSON.stringify({
          traceSchema: "openclaw-trajectory-pointer",
          runtimeFile: path.join(state.sessionsDir("main"), "missing.trajectory.jsonl"),
        });
        if (leftoverPointer) {
          fs.writeFileSync(pointer, pointerBytes);
        }
        const target = (await run()).targets[0]!;
        const receiptParams = { cfg, env: state.env, target, sqlitePath: target.sqlitePath };
        const receipt = readDeferredPluginSessionImport(receiptParams)!;
        await editAndDeleteImportedSessions(scope, "current SQLite metadata");
        const originalEvents = readEvents("legacy-kept");
        await completePluginMigration(state.env);
        const archived = await run();
        expect(receipt.sources.every((source) => !fs.existsSync(source.path))).toBe(true);
        expect(readDeferredPluginSessionImport(receiptParams)).toBeUndefined();
        const transcript = path.join(path.dirname(target.storePath), "legacy-kept.jsonl");
        const manifest = migrationRun.readSessionSqliteMigrationManifest(
          archived.migrationRun!.manifestPath,
        )!;
        const move = manifest.targets
          .flatMap((entry) => entry.completedMoves)
          .find((entry) => entry.sourcePath === transcript)!;
        // Older interrupted settlements can leave a pointer beside an archived transcript.
        if (leftoverPointer) {
          fs.writeFileSync(pointer, pointerBytes);
        }
        // Recreate the unfinished receipt left by a published version after successful archival.
        reactivateArchivedReceipt(state.env);
        if (damage === "missing") {
          fs.unlinkSync(move.archivePath);
        } else {
          fs.appendFileSync(move.archivePath, "\n");
        }
        const laterTranscript = path.join(path.dirname(target.storePath), "later-history.jsonl");
        const laterBytes = `${JSON.stringify({ type: "session", version: 3, id: "later-history" })}\n`;
        fs.writeFileSync(laterTranscript, laterBytes);

        const refused = await run();
        expect(hasDeferredPluginSessionImport(receiptParams)).toBe(true);
        if (leftoverPointer) {
          expectFiles(pointerBytes, pointer);
        }
        expectIssue(refused, {
          code: issueCode,
          message: expect.stringContaining(transcript),
        });
        expect(refused.totals.importedEntries).toBe(0);
        expect(refused.totals.importedTranscriptEvents).toBe(0);
        expectFiles(laterBytes, laterTranscript);
        expect(readEvents("later-history")).toEqual([]);
        expect(readEvents("legacy-kept")).toEqual(originalEvents);
        expectCanonicalSessions(scope, "current SQLite metadata");
      });
    },
  );

  it("supersedes an archived receipt bound to a replaced database before importing later history", async () => {
    await withOpenClawTestState({ label: "deferred-archived-database-rebind" }, async (state) => {
      const { cfg, scope, run, readEntry, readEvents } = await seedRetainedSource(state, "default");
      const target = (await run()).targets[0]!;
      const receiptParams = { cfg, env: state.env, target, sqlitePath: target.sqlitePath };
      const receipt = readDeferredPluginSessionImport(receiptParams)!;
      await patchSessionEntryCore(
        { ...scope, sessionKey: "agent:main:kept" },
        () => ({ label: "current SQLite metadata" }),
        { skipMaintenance: true },
      );
      const originalEvents = readEvents("legacy-kept");
      await completePluginMigration(state.env);
      await run();
      expect(receipt.sources.every((source) => !fs.existsSync(source.path))).toBe(true);
      expect(readDeferredPluginSessionImport(receiptParams)).toBeUndefined();
      // Published releases left the archived receipt active across later database restores.
      reactivateArchivedReceipt(state.env);
      await closeOpenClawAgentDatabasesAsync();
      fs.copyFileSync(target.sqlitePath, `${target.sqlitePath}.replacement`);
      fs.renameSync(`${target.sqlitePath}.replacement`, target.sqlitePath);
      expect(databaseIdentity(target.sqlitePath)).not.toBe(receipt.databaseIdentity);

      const laterEvents = [
        {
          type: "session",
          version: 3,
          id: "later-history",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: "/legacy/workspace",
        },
        {
          type: "message",
          id: "later-message",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "new history after database replacement" },
        },
      ];
      const laterTranscript = path.join(path.dirname(target.storePath), "later-history.jsonl");
      fs.writeFileSync(
        laterTranscript,
        `${laterEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      const recovered = await run();
      const issues = recovered.targets.flatMap((entry) => entry.issues);
      expect(issues).not.toContainEqual(
        expect.objectContaining({ code: "retained_plugin_source_conflict" }),
      );
      containsObjects(issues, { code: "retained_plugin_receipt_superseded" });
      expect(recovered.totals.importedEntries).toBe(1);
      expect(recovered.totals.importedTranscriptEvents).toBe(2);
      expect(readDeferredPluginSessionImport(receiptParams)).toBeUndefined();
      expect(readEntry("agent:main:kept")?.entry.label).toBe("current SQLite metadata");
      expect(readEvents("legacy-kept")).toEqual(originalEvents);

      expect(readEvents("later-history")).toEqual(laterEvents);
      const later = await run();
      expect(later.totals.importedEntries).toBe(0);
      expect(later.totals.importedTranscriptEvents).toBe(0);
      expect(readEvents("later-history")).toEqual(laterEvents);
    });
  });

  it("preserves canonical edits when an indexless receipt meets a recreated legacy index", async () => {
    await withOpenClawTestState({ label: "deferred-recreated-index" }, async (state) => {
      const { cfg, storePath, scope, originals, run } = await seedRetainedSource(state, "default");
      const imported = await run();
      const target = imported.targets[0]!;
      const receipt = readDeferredPluginSessionImport({
        cfg,
        env: state.env,
        target,
        sqlitePath: target.sqlitePath,
      })!;
      await editAndDeleteImportedSessions(scope, "current SQLite metadata");
      await completePluginMigration(state.env);
      await run();
      expectMissing(storePath);
      // Older indexless receipts can outlive archival; a later index is unverified input.
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(
            "UPDATE migration_sources SET removed_source = 0, report_json = ? WHERE migration_kind = 'deferred-plugin-session-import'",
          ).run(
            JSON.stringify({
              ...receipt,
              sources: receipt.sources.filter((source) => source.path !== storePath),
            }),
          );
        },
        { env: state.env },
      );
      fs.writeFileSync(storePath, originals.get(storePath)!);

      const publish = directoryDurability.publishFileExclusive;
      const publication = vi
        .spyOn(directoryDurability, "publishFileExclusive")
        .mockImplementation(async (options) => {
          if (options.sourcePath === storePath) {
            throw new Error("fixture recreated-index publication interrupted");
          }
          return publish(options);
        });
      await run();
      publication.mockRestore();
      expect(fs.readFileSync(storePath)).toEqual(originals.get(storePath));
      expect(
        hasDeferredPluginSessionImport({ target, sqlitePath: target.sqlitePath, env: state.env }),
      ).toBe(true);
      expectCanonicalSessions(scope, "current SQLite metadata");

      const repaired = await run();
      expect(repaired.totals.importedEntries).toBe(0);
      expectIssue(repaired, { code: "retained_plugin_source_conflict" });
      expectCanonicalSessions(scope, "current SQLite metadata");
      const manifest = migrationRun.readSessionSqliteMigrationManifest(
        repaired.migrationRun!.manifestPath,
      )!;
      const archivedIndex = manifest.targets
        .flatMap((entry) => entry.completedMoves)
        .find((move) => move.sourcePath === storePath)!;
      expect(archivedIndex.artifact?.classification).toBe("protected");
      expect(fs.readFileSync(archivedIndex.archivePath)).toEqual(originals.get(storePath));
      await run();
      expectCanonicalSessions(scope, "current SQLite metadata");
    });
  });

  it.each(["completed", "disabled", "uninstalled", "globally-disabled"] as const)(
    "requires migration completion before retiring a %s plugin's retained inputs",
    async (completion) => {
      await withOpenClawTestState({ label: "deferred-plugin-receipt-lifecycle" }, async (state) => {
        const { cfg, storePath, scope, run, readEvents } = await seedRetainedSource(
          state,
          "default",
        );
        const imported = await run();
        const target = imported.targets[0]!;
        const receipt = () =>
          readDeferredPluginSessionImport({
            cfg,
            env: state.env,
            target,
            sqlitePath: target.sqlitePath,
          });
        expect(receipt()).toBeDefined();
        await editAndDeleteImportedSessions(scope, "current SQLite metadata");
        const transcript = path.join(path.dirname(storePath), "new-history.jsonl");
        const contents =
          [
            { type: "session", version: 3, id: "new-history" },
            messageEvent("new-message", "user", "new history"),
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n";
        fs.writeFileSync(transcript, contents);
        const pending = await run();
        expect(pending.totals.importedEntries).toBe(0);
        expectIssue(pending, {
          code: "plugin_migration_source_retained",
          message: expect.stringContaining("deferred-plugin-session-import"),
        });
        expectFiles(contents, transcript);
        if (completion === "completed") {
          await completePluginMigration(state.env);
        } else {
          // Uninstall persists the same explicit disable marker after removing its package.
          cfg.plugins = {
            ...(completion === "globally-disabled"
              ? { enabled: false }
              : { entries: { "fixture-plugin": { enabled: false } } }),
            ...(completion === "disabled"
              ? {
                  installs: {
                    "fixture-plugin": { source: "npm", spec: "@example/fixture-plugin" },
                  },
                }
              : {}),
          };
          await run();
          containsObjects(readDeferredPluginMigrations({ env: state.env }), {
            pluginId: "fixture-plugin",
          });
          expect(receipt()).toBeDefined();
          expectFiles(contents, transcript);
          expectCanonicalSessions(scope, "current SQLite metadata");
          return;
        }
        await run();
        expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
        expect(receipt()).toBeUndefined();
        expectFiles(contents, transcript);
        // Published versions left archived receipts active indefinitely.
        reactivateArchivedReceipt(state.env);
        expect(receipt()).toBeDefined();
        const later = await run();
        expect(later.totals.importedEntries).toBe(1);
        expect(later.totals.importedTranscriptEvents).toBe(2);
        expect(readEvents("new-history")).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "new-message" })]),
        );
        expectCanonicalSessions(scope, "current SQLite metadata");
        expect(receipt()).toBeUndefined();
      });
    },
  );
});

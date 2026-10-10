import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
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
import {
  editAndDeleteImportedSessions,
  seedDeferredPluginSessionSource,
} from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

afterEach(() => vi.restoreAllMocks());

type SessionScope = Awaited<ReturnType<typeof seedDeferredPluginSessionSource>>["scope"];

function expectCanonicalSessions(scope: SessionScope, label: string) {
  expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(
    label,
  );
  expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
}

describe("deferred plugin session receipt retirement", () => {
  it.each(["missing", "changed"] as const)(
    "keeps a receipt active when its archived transcript is %s",
    async (damage) => {
      await withOpenClawTestState({ label: "deferred-damaged-archive" }, async (state) => {
        const { cfg, scope } = await seedDeferredPluginSessionSource(state, "default");
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const target = (await run()).targets[0]!;
        const receiptParams = { cfg, env: state.env, target, sqlitePath: target.sqlitePath };
        const receipt = readDeferredPluginSessionImport(receiptParams)!;
        await editAndDeleteImportedSessions(scope, "current SQLite metadata");
        const originalEvents = loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" });
        await recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
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
        // Recreate the unfinished receipt left by a published version after successful archival.
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(
              "UPDATE migration_sources SET removed_source = 0 WHERE migration_kind = 'deferred-plugin-session-import'",
            ).run();
          },
          { env: state.env },
        );
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
        expect(refused.targets.flatMap((entry) => entry.issues)).toContainEqual(
          expect.objectContaining({
            code: "retained_plugin_source_conflict",
            message: expect.stringContaining(transcript),
          }),
        );
        expect(refused.totals.importedEntries).toBe(0);
        expect(refused.totals.importedTranscriptEvents).toBe(0);
        expect(fs.readFileSync(laterTranscript, "utf8")).toBe(laterBytes);
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "later-history" })).toEqual([]);
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toEqual(
          originalEvents,
        );
        expectCanonicalSessions(scope, "current SQLite metadata");
      });
    },
  );

  it("rebinds an archived receipt to a replaced database before retiring it and importing later history", async () => {
    await withOpenClawTestState({ label: "deferred-archived-database-rebind" }, async (state) => {
      const { cfg, scope } = await seedDeferredPluginSessionSource(state, "default");
      const run = () =>
        runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
      const target = (await run()).targets[0]!;
      const receiptParams = { cfg, env: state.env, target, sqlitePath: target.sqlitePath };
      const receipt = readDeferredPluginSessionImport(receiptParams)!;
      await patchSessionEntryCore(
        { ...scope, sessionKey: "agent:main:kept" },
        () => ({ label: "current SQLite metadata" }),
        { skipMaintenance: true },
      );
      const originalEvents = loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" });
      await recordDeferredPluginMigrations({
        env: state.env,
        pending: [],
        resolvedPluginIds: ["fixture-plugin"],
      });
      await run();
      expect(receipt.sources.every((source) => !fs.existsSync(source.path))).toBe(true);
      expect(readDeferredPluginSessionImport(receiptParams)).toBeUndefined();
      // Published releases left the archived receipt active across later database restores.
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(
            "UPDATE migration_sources SET removed_source = 0 WHERE migration_kind = 'deferred-plugin-session-import'",
          ).run();
        },
        { env: state.env },
      );
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
      const rebound = await run();
      const issues = rebound.targets.flatMap((entry) => entry.issues);
      expect(issues).not.toContainEqual(
        expect.objectContaining({ code: "retained_plugin_source_conflict" }),
      );
      expect(issues).toContainEqual(
        expect.objectContaining({ code: "retained_plugin_source_index_rebuilt" }),
      );
      expect(rebound.totals.importedEntries).toBe(1);
      expect(rebound.totals.importedTranscriptEvents).toBe(2);
      expect(readDeferredPluginSessionImport(receiptParams)).toBeUndefined();
      expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(
        "current SQLite metadata",
      );
      expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toEqual(
        originalEvents,
      );

      expect(loadTranscriptEventsSync({ ...scope, sessionId: "later-history" })).toEqual(
        laterEvents,
      );
      const later = await run();
      expect(later.totals.importedEntries).toBe(0);
      expect(later.totals.importedTranscriptEvents).toBe(0);
      expect(loadTranscriptEventsSync({ ...scope, sessionId: "later-history" })).toEqual(
        laterEvents,
      );
    });
  });

  it("preserves canonical edits when an indexless receipt meets a recreated legacy index", async () => {
    await withOpenClawTestState({ label: "deferred-recreated-index" }, async (state) => {
      const { cfg, storePath, scope, originals } = await seedDeferredPluginSessionSource(
        state,
        "default",
      );
      const run = () =>
        runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
      const imported = await run();
      const target = imported.targets[0]!;
      const receipt = readDeferredPluginSessionImport({
        cfg,
        env: state.env,
        target,
        sqlitePath: target.sqlitePath,
      })!;
      await editAndDeleteImportedSessions(scope, "current SQLite metadata");
      await recordDeferredPluginMigrations({
        env: state.env,
        pending: [],
        resolvedPluginIds: ["fixture-plugin"],
      });
      await run();
      expect(fs.existsSync(storePath)).toBe(false);
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
      expect(repaired.targets.flatMap((entry) => entry.issues)).toContainEqual(
        expect.objectContaining({ code: "retained_plugin_source_conflict" }),
      );
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
        const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
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
            {
              type: "message",
              id: "new-message",
              parentId: null,
              message: { role: "user", content: "new history" },
            },
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n";
        fs.writeFileSync(transcript, contents);
        const pending = await run();
        expect(pending.totals.importedEntries).toBe(0);
        expect(pending.targets.flatMap((entry) => entry.issues)).toContainEqual(
          expect.objectContaining({
            code: "plugin_migration_source_retained",
            message: expect.stringContaining("deferred-plugin-session-import"),
          }),
        );
        expect(fs.readFileSync(transcript, "utf8")).toBe(contents);
        if (completion === "completed") {
          await recordDeferredPluginMigrations({
            env: state.env,
            pending: [],
            resolvedPluginIds: ["fixture-plugin"],
          });
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
          expect(readDeferredPluginMigrations({ env: state.env })).toContainEqual(
            expect.objectContaining({ pluginId: "fixture-plugin" }),
          );
          expect(receipt()).toBeDefined();
          expect(fs.readFileSync(transcript, "utf8")).toBe(contents);
          expectCanonicalSessions(scope, "current SQLite metadata");
          return;
        }
        await run();
        expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
        expect(receipt()).toBeUndefined();
        expect(fs.readFileSync(transcript, "utf8")).toBe(contents);
        // Published versions left archived receipts active indefinitely.
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(
              "UPDATE migration_sources SET removed_source = 0 WHERE migration_kind = 'deferred-plugin-session-import'",
            ).run();
          },
          { env: state.env },
        );
        expect(receipt()).toBeDefined();
        const later = await run();
        expect(later.totals.importedEntries).toBe(1);
        expect(later.totals.importedTranscriptEvents).toBe(2);
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "new-history" })).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "new-message" })]),
        );
        expectCanonicalSessions(scope, "current SQLite metadata");
        expect(receipt()).toBeUndefined();
      });
    },
  );
});

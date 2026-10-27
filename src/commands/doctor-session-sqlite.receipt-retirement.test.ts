import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { databaseIdentity } from "../infra/deferred-plugin-session-verification.js";
import * as directoryDurability from "../infra/directory-durability.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { editAndDeleteImportedSessions } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import type { seedRetainedSource } from "./doctor-session-sqlite.fixtures.test-support.js";
import {
  messageEvent,
  jsonl,
  archivedSource,
  expectIssue,
  withRetainedSource,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import {
  expectMissing,
  expectFiles,
  containsObjects,
} from "./doctor-session-sqlite.publication-spies.test-support.js";

afterEach(() => vi.restoreAllMocks());

type SessionScope = Awaited<ReturnType<typeof seedRetainedSource>>["scope"];
const currentLabel = "current SQLite metadata";

function expectCanonicalSessions(scope: SessionScope) {
  expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(
    currentLabel,
  );
  expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
}

function reactivateArchivedReceipt(env: NodeJS.ProcessEnv, reportJson?: string) {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        `UPDATE migration_sources SET removed_source = 0${reportJson === undefined ? "" : ", report_json = ?"} WHERE migration_kind = 'deferred-plugin-session-import'`,
      ).run(...(reportJson === undefined ? [] : [reportJson]));
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

it.each([
  ["missing", false, "retained_plugin_source_conflict"],
  ["changed", false, "retained_plugin_source_conflict"],
  ["missing", true, "historical_transcript_deferred"],
  ["changed", true, "historical_transcript_deferred"],
] as const)(
  "keeps a receipt active when its archived transcript is %s (leftover pointer: %s)",
  (damage, leftoverPointer, issueCode) =>
    withRetainedSource(async ({ scope, run, readEvents, readReceipt, hasReceipt, state }) => {
      const pointer = path.join(state.sessionsDir("main"), "legacy-kept.trajectory-path.json");
      const pointerBytes = JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        runtimeFile: path.join(state.sessionsDir("main"), "missing.trajectory.jsonl"),
      });
      if (leftoverPointer) {
        fs.writeFileSync(pointer, pointerBytes);
      }
      const target = (await run()).targets[0]!;
      const receipt = readReceipt(target)!;
      await editAndDeleteImportedSessions(scope, currentLabel);
      const originalEvents = readEvents("legacy-kept");
      await completePluginMigration(state.env);
      const archived = await run();
      expect(receipt.sources.every((source) => !fs.existsSync(source.path))).toBe(true);
      expect(readReceipt(target)).toBeUndefined();
      const transcript = path.join(path.dirname(target.storePath), "legacy-kept.jsonl");
      const move = archivedSource(archived, transcript);
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
      expect(hasReceipt(target)).toBe(true);
      if (leftoverPointer) {
        expectFiles(pointerBytes, pointer);
      }
      expectIssue(refused, {
        code: issueCode,
        message: expect.stringContaining(transcript),
      });
      expect(refused.totals).toMatchObject({ importedEntries: 0, importedTranscriptEvents: 0 });
      expectFiles(laterBytes, laterTranscript);
      expect(readEvents("later-history")).toEqual([]);
      expect(readEvents("legacy-kept")).toEqual(originalEvents);
      expectCanonicalSessions(scope);
    }),
);

it("supersedes an archived receipt bound to a replaced database before importing later history", () =>
  withRetainedSource(async ({ scope, run, readEntry, readEvents, readReceipt, state }) => {
    const target = (await run()).targets[0]!;
    const receipt = readReceipt(target)!;
    await patchSessionEntryCore(
      { ...scope, sessionKey: "agent:main:kept" },
      () => ({ label: currentLabel }),
      { skipMaintenance: true },
    );
    const originalEvents = readEvents("legacy-kept");
    await completePluginMigration(state.env);
    await run();
    expect(receipt.sources.every((source) => !fs.existsSync(source.path))).toBe(true);
    expect(readReceipt(target)).toBeUndefined();
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
        ...messageEvent("later-message", "user", "new history after database replacement"),
        timestamp: "2026-06-15T00:00:01.000Z",
      },
    ];
    const laterTranscript = path.join(path.dirname(target.storePath), "later-history.jsonl");
    fs.writeFileSync(laterTranscript, jsonl(...laterEvents));
    const recovered = await run();
    const issues = recovered.targets.flatMap((entry) => entry.issues);
    expect(issues).not.toContainEqual(
      expect.objectContaining({ code: "retained_plugin_source_conflict" }),
    );
    containsObjects(issues, { code: "retained_plugin_receipt_superseded" });
    expect(recovered.totals).toMatchObject({ importedEntries: 1, importedTranscriptEvents: 2 });
    expect(readReceipt(target)).toBeUndefined();
    expect(readEntry("agent:main:kept")?.entry.label).toBe(currentLabel);
    expect(readEvents("legacy-kept")).toEqual(originalEvents);

    expect(readEvents("later-history")).toEqual(laterEvents);
    const later = await run();
    expect(later.totals).toMatchObject({ importedEntries: 0, importedTranscriptEvents: 0 });
    expect(readEvents("later-history")).toEqual(laterEvents);
  }));

it("preserves canonical edits when an indexless receipt meets a recreated legacy index", () =>
  withRetainedSource(
    async ({ storePath, scope, originals, run, readReceipt, hasReceipt, state }) => {
      const imported = await run();
      const target = imported.targets[0]!;
      const receipt = readReceipt(target)!;
      await editAndDeleteImportedSessions(scope, currentLabel);
      await completePluginMigration(state.env);
      await run();
      expectMissing(storePath);
      // Older indexless receipts can outlive archival; a later index is unverified input.
      reactivateArchivedReceipt(
        state.env,
        JSON.stringify({
          ...receipt,
          sources: receipt.sources.filter((source) => source.path !== storePath),
        }),
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
      expect(hasReceipt(target)).toBe(true);
      expectCanonicalSessions(scope);

      const repaired = await run();
      expect(repaired.totals.importedEntries).toBe(0);
      expectIssue(repaired, { code: "retained_plugin_source_conflict" });
      expectCanonicalSessions(scope);
      const archivedIndex = archivedSource(repaired, storePath);
      expect(archivedIndex.artifact?.classification).toBe("protected");
      expect(fs.readFileSync(archivedIndex.archivePath)).toEqual(originals.get(storePath));
      await run();
      expectCanonicalSessions(scope);
    },
  ));

it.each(["completed", "disabled", "uninstalled", "globally-disabled"] as const)(
  "requires migration completion before retiring a %s plugin's retained inputs",
  (completion) =>
    withRetainedSource(async ({ cfg, storePath, scope, run, readEvents, readReceipt, state }) => {
      const imported = await run();
      const target = imported.targets[0]!;
      const receipt = () => readReceipt(target);
      expect(receipt()).toBeDefined();
      await editAndDeleteImportedSessions(scope, currentLabel);
      const transcript = path.join(path.dirname(storePath), "new-history.jsonl");
      const contents = jsonl(
        { type: "session", version: 3, id: "new-history" },
        messageEvent("new-message", "user", "new history"),
      );
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
        expectCanonicalSessions(scope);
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
      expect(later.totals).toMatchObject({ importedEntries: 1, importedTranscriptEvents: 2 });
      expect(readEvents("new-history")).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "new-message" })]),
      );
      expectCanonicalSessions(scope);
      expect(receipt()).toBeUndefined();
    }),
);

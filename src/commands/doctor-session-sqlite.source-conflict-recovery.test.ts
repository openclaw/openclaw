import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
} from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import * as directoryDurability from "../infra/directory-durability.js";
import { readSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { countBlockingSessionSqliteIssues } from "./doctor-session-sqlite-types.js";
import { expectIssue, seedRetainedSource } from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  expectMissing,
  expectFiles,
  containsObjects,
} from "./doctor-session-sqlite.publication-spies.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("retained plugin session source recovery", () => {
  it("preserves a transcript when its index changes during archive publication", async () => {
    await withOpenClawTestState({ label: "retained-archive-owner-change" }, async (state) => {
      const { storePath, run, readEntry } = await seedRetainedSource(state);
      await run();
      const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      const changed = fs
        .readFileSync(transcript, "utf8")
        .replace('"content":"kept"', '"content":"conflict"');
      fs.writeFileSync(transcript, changed);
      const publish = directoryDurability.publishFileExclusive;
      let changedIndex = false;
      vi.spyOn(directoryDurability, "publishFileExclusive").mockImplementation(
        async (publication) => {
          const result = await publish(publication);
          if (publication.sourcePath === transcript) {
            const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
            entries["agent:main:new"] = {
              sessionId: "new",
              sessionFile: path.basename(transcript),
              updatedAt: 30,
            };
            fs.writeFileSync(storePath, JSON.stringify(entries));
            changedIndex = true;
          }
          return result;
        },
      );
      const result = await run();
      expect(changedIndex).toBe(true);
      expect(result.totals.archivedTranscriptFiles).toBe(0);
      expectFiles(changed, transcript);
      expect(fs.statSync(transcript).nlink).toBe(1);
      expectIssue(result, {
        message: expect.stringContaining("Session index changed after owner discovery"),
      });
      expect(readEntry("agent:main:new")).toBeUndefined();
    });
  });

  it("reverifies a changed valid retained index without replaying canonical metadata", async () => {
    await withOpenClawTestState({ label: "retained-source-changed-valid-index" }, async (state) => {
      const { cfg, storePath, scope, run, readEntry } = await seedRetainedSource(
        state,
        "default",
        "codex",
      );
      expect((await run("import")).totals).toMatchObject({
        importedEntries: 2,
        sqliteEntries: 2,
      });
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:kept" },
        { label: "current" },
      );
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:created-after-import" },
        { sessionId: "new-canonical", updatedAt: 30, label: "current" },
      );
      const readCurrent = () =>
        ["agent:main:kept", "agent:main:created-after-import"].map(readEntry);
      const current = readCurrent();
      expect(current).toMatchObject([
        { entry: { label: "current" } },
        { entry: { sessionId: "new-canonical", label: "current" } },
      ]);
      fs.appendFileSync(storePath, "\r\n");
      const retainedIndex = fs.readFileSync(storePath);

      const repaired = await run("import");
      expect(repaired.totals).toMatchObject({ importedEntries: 0, sqliteEntries: 3 });
      expect(
        repaired.targets.every((target) => countBlockingSessionSqliteIssues(target) === 0),
      ).toBe(true);
      expectIssue(repaired, {
        code: "retained_plugin_source_index_rebuilt",
        message: expect.stringContaining(storePath),
      });
      expect(readCurrent()).toEqual(current);
      expectFiles(retainedIndex, storePath);
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
    });
  });

  it("reconciles a smaller retained index and reports only its differing session metadata", async () => {
    await withOpenClawTestState({ label: "retained-index-runtime-metadata" }, async (state) => {
      const { cfg, storePath, scope, run } = await seedRetainedSource(state, "default");
      const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
      for (let index = 0; index < 10; index += 1) {
        entries[`agent:main:unchanged-${index}`] = {
          sessionId: `unchanged-${index}`,
          updatedAt: 20,
        };
      }
      entries["agent:main:kept"].skillsSnapshot = { prompt: "original", skills: [] };
      entries["agent:main:deleted"].inputTokens = 100;
      fs.writeFileSync(storePath, JSON.stringify(entries).padEnd(190_020));
      const imported = await run("import");
      expect(imported.totals.sqliteEntries).toBe(12);
      const readCanonical = () =>
        Object.keys(entries).map((sessionKey) => loadExactSessionEntry({ ...scope, sessionKey }));
      const canonical = readCanonical();
      const manifestPath = expectDefined(imported.migrationRun?.manifestPath, "import manifest");
      const failed = expectDefined(readSessionSqliteMigrationManifest(manifestPath), "manifest");
      failed.failedAt = failed.startedAt;
      const failedTarget = expectDefined(failed.targets[0], "failed target");
      failedTarget.issues = [];
      failedTarget.validationBeforeArchive = "not_run";
      fs.writeFileSync(manifestPath, JSON.stringify(failed));

      entries["agent:main:kept"].skillsSnapshot.prompt = "runtime snapshot";
      entries["agent:main:kept"].updatedAt = 21;
      entries["agent:main:deleted"].inputTokens = 200;
      const changed = JSON.stringify(entries).padEnd(187_332);
      fs.writeFileSync(storePath, changed);
      const recovered = await run("recover");
      const report = expectDefined(recovered.targets[0], "recovered target");

      expect(report.sqliteEntries).toBe(12);
      expect(report.importedEntries).toBe(0);
      expect(countBlockingSessionSqliteIssues(report)).toBe(0);
      expect(readCanonical()).toEqual(canonical);
      const archive = expectDefined(report.archivedLegacyStoreFiles?.[0], "protected index");
      expectFiles(changed, archive);
      expectMissing(storePath);
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
      expect(report.issues.filter((issue) => issue.sessionKey)).toEqual([
        expect.objectContaining({
          code: "retained_plugin_source_conflict",
          sessionKey: "agent:main:kept",
          message: expect.stringContaining("skillsSnapshot, updatedAt"),
        }),
        expect.objectContaining({
          code: "retained_plugin_source_conflict",
          sessionKey: "agent:main:deleted",
          message: expect.stringContaining("inputTokens"),
        }),
      ]);
      const failureJson = JSON.parse(
        fs.readFileSync(
          expectDefined(recovered.migrationRun?.failureReportJsonPath, "failure JSON"),
          "utf8",
        ),
      );
      expect(
        failureJson.targets[0].recoveryIssues.map(({ code }: { code: string }) => code),
      ).toEqual(report.issues.map(({ code }) => code));
      const markdown = fs.readFileSync(
        expectDefined(recovered.migrationRun?.failureReportMarkdownPath, "failure Markdown"),
        "utf8",
      );
      expect(markdown).toContain(`Current recovery issues: ${report.issues.length}`);
      expect(markdown).toContain("skillsSnapshot, updatedAt");
      expect(markdown).toContain("inputTokens");
    });
  });

  it.each([
    { reversed: false, foreign: false },
    { reversed: true, foreign: false },
    { reversed: false, foreign: true },
  ])(
    "binds changed shared transcripts to every indexed session (reversed: $reversed, foreign: $foreign)",
    async ({ reversed, foreign }) => {
      await withOpenClawTestState({ label: "retained-transcript-owner" }, async (state) => {
        const { storePath, scope, run, readEvents } = await seedRetainedSource(state, "default");
        const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
        const foreignPath = state.path("foreign-root/agents/main/sessions/legacy-deleted.jsonl");
        entries["agent:main:kept"].sessionFile = foreign ? foreignPath : "legacy-deleted.jsonl";
        fs.unlinkSync(path.join(path.dirname(storePath), "legacy-kept.jsonl"));
        fs.writeFileSync(
          storePath,
          JSON.stringify(
            reversed ? Object.fromEntries(Object.entries(entries).toReversed()) : entries,
          ),
        );
        await run();
        const kept = readEvents("legacy-kept");
        expect(kept).toHaveLength(2);
        await appendTranscriptEvent(
          { ...scope, sessionId: "legacy-deleted", sessionKey: "agent:main:deleted" },
          {
            type: "custom",
            id: "only-deleted",
            parentId: "deleted-message",
            timestamp: "2026-09-01T00:00:00.000Z",
            customType: "fixture",
            data: { owner: "deleted" },
          },
        );
        const transcript = path.join(path.dirname(storePath), "legacy-deleted.jsonl");
        const current = readEvents("legacy-deleted");
        fs.writeFileSync(
          transcript,
          current.map((event) => JSON.stringify(event)).join("\n") + "\n",
        );
        if (foreign) {
          fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
          fs.copyFileSync(transcript, foreignPath);
        }
        const bytes = fs.readFileSync(transcript);
        const result = await run();
        expect(result.totals.importedEntries).toBe(0);
        expectMissing(transcript);
        const archived = expectDefined(
          result.targets[0]?.archivedTranscriptFiles[0],
          "protected shared transcript",
        );
        expectFiles(bytes, archived);
        expect(readEvents("legacy-kept")).toEqual(kept);
        expect(readEvents("legacy-deleted")).toEqual(current);
        if (foreign) {
          expectFiles(bytes, foreignPath);
        }
      });
    },
  );

  it("keeps a truncated shared index until every owner is selected", async () => {
    await withOpenClawTestState({ label: "retained-shared-source" }, async (state) => {
      const { cfg, storePath, scope, readEntry } = await seedRetainedSource(state, "external");
      cfg.agents = {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      };
      const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
      entries["agent:ops:waiting"] = { sessionId: "legacy-ops", updatedAt: 20 };
      fs.writeFileSync(storePath, JSON.stringify(entries));
      const options = { cfg, env: state.env, mode: "import" as const };
      await runDoctorSessionSqlite({ ...options, store: storePath, agent: "main" });
      entries["agent:main:kept"].sessionId = "unimported-new-main";

      delete entries["agent:ops:waiting"];

      const changed = JSON.stringify(entries);
      fs.writeFileSync(storePath, changed);
      const partial = await runDoctorSessionSqlite({
        ...options,
        store: storePath,
        agent: "main",
      });
      expectFiles(changed, storePath);
      expect(partial.totals.archivedLegacyStoreFiles).toBe(0);
      expect(
        fs.existsSync(
          resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "ops", env: state.env })
            .path,
        ),
      ).toBe(false);
      const unrelated = path.join(state.sessionsDir("retired"), "sessions.json");
      fs.mkdirSync(path.dirname(unrelated), { recursive: true });
      fs.writeFileSync(
        unrelated,
        JSON.stringify({ "agent:retired:old": { sessionId: "old", updatedAt: 10 } }),
      );
      const completed = await runDoctorSessionSqlite({ ...options, allAgents: true });
      expect(completed.totals.importedEntries).toBe(1);
      expectMissing(storePath);
      expect(readEntry("agent:main:kept")?.entry.sessionId).toBe("legacy-kept");
      expect(
        loadExactSessionEntry({ ...scope, agentId: "ops", sessionKey: "agent:ops:waiting" })?.entry
          .sessionId,
      ).toBe(undefined);
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
    });
  });

  it("protects an unindexed source replaced with a later canonical transcript", async () => {
    await withOpenClawTestState({ label: "retained-unindexed-owner" }, async (state) => {
      const { cfg, storePath, scope, run, readEvents } = await seedRetainedSource(state, "default");
      const source = path.join(path.dirname(storePath), "legacy-later.jsonl");
      fs.writeFileSync(source, '{"type":"custom","unimported":true}\n');
      await run();
      expectFiles('{"type":"custom","unimported":true}\n', source);
      const later = { ...scope, sessionKey: "agent:main:later", sessionId: "legacy-later" };
      expect(loadExactSessionEntry(later)).toBeUndefined();
      await upsertSessionEntryCore(later, { sessionId: later.sessionId, updatedAt: 30 });
      const header = readEvents("legacy-kept")[0];
      assert(isRecord(header));
      await appendTranscriptEvent(later, { ...header, id: later.sessionId });
      await appendTranscriptMessage(later, { message: { role: "user", content: "later" } });
      const events = loadTranscriptEventsSync(later);
      const replacement = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      fs.writeFileSync(source, replacement);
      const result = await run();
      expect(result.totals.importedEntries).toBe(0);
      const archive = expectDefined(
        result.targets[0]?.archivedTranscriptFiles[0],
        "protected unindexed source",
      );
      expectFiles(replacement, archive);
      expectMissing(source);
      expect(loadTranscriptEventsSync(later)).toEqual(events);
      expectIssue(result, {
        message: expect.stringContaining("no verified indexed owner"),
      });
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
    });
  });

  it("archives an invalid shared index without blocking canonical sessions", async () => {
    await withOpenClawTestState(
      { label: "retained-source-invalid-shared-index" },
      async (state) => {
        const { cfg, storePath, scope, run, readEntry, readEvents } = await seedRetainedSource(
          state,
          "external",
          "codex",
        );

        await run("import");

        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "current" },
        );

        const sourcePath = storePath;

        const changedBytes = Buffer.from('{"agent:main:kept":\r\n');
        fs.writeFileSync(sourcePath, changedBytes);
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        const repaired = await run("import");
        expect(repaired.totals).toMatchObject({ importedEntries: 0, sqliteEntries: 2 });
        expect(
          repaired.targets.every((target) => countBlockingSessionSqliteIssues(target) === 0),
        ).toBe(true);
        expectIssue(repaired, {
          code: "retained_plugin_source_conflict",
          message: expect.stringContaining(sourcePath),
        });
        const manifest = expectDefined(
          readSessionSqliteMigrationManifest(
            expectDefined(repaired.migrationRun?.manifestPath, "recovery migration manifest"),
          ),
          "readable recovery migration manifest",
        );
        const archived = expectDefined(
          manifest.targets
            .flatMap((target) => target.completedMoves)
            .find((move) => move.sourcePath === sourcePath),
          "protected conflicting source archive",
        );
        expect(archived.artifact).toMatchObject({
          classification: "protected",
          disposal: { state: "retained" },
        });
        expectFiles(changedBytes, archived.archivePath);
        expectMissing(sourcePath);
        expect(readEntry("agent:main:kept")?.entry.label).toBe("current");
        const events = readEvents("legacy-kept");
        expect(events).toHaveLength(2);
        containsObjects(events, {
          id: "kept-message",
          message: expect.objectContaining({ role: "user", content: "kept" }),
        });
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        expect((await run("inspect")).totals.sqliteEntries).toBe(2);
        expectFiles(changedBytes, archived.archivePath);
      },
    );
  });
});

import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
} from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import { readDeferredPluginSessionImport } from "../infra/deferred-plugin-session-sources.js";
import * as directoryDurability from "../infra/directory-durability.js";
import { readSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import { createPluginDoctorStateMigrationContext } from "../infra/state-migrations.plugin-doctor-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { countBlockingSessionSqliteIssues } from "./doctor-session-sqlite-types.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

afterEach(() => vi.restoreAllMocks());

describe("retained plugin session source recovery", () => {
  it("preserves a transcript when its index changes during archive publication", async () => {
    await withOpenClawTestState({ label: "retained-archive-owner-change" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
      const options = { cfg, env: state.env, allAgents: true, mode: "import" as const };
      await runDoctorSessionSqlite(options);
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
      const result = await runDoctorSessionSqlite(options);
      expect(changedIndex).toBe(true);
      expect(result.totals.archivedTranscriptFiles).toBe(0);
      expect(fs.readFileSync(transcript, "utf8")).toBe(changed);
      expect(fs.statSync(transcript).nlink).toBe(1);
      expect(result.targets.flatMap((target) => target.issues)).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("Session index changed after owner discovery"),
        }),
      );
      expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:new" })).toBeUndefined();
    });
  });

  it("accepts an atomically replaced 67 KiB CRLF index with unchanged bytes", async () => {
    await withOpenClawTestState({ label: "retained-source-identical" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(
        state,
        "default",
        "codex",
      );
      const index = Buffer.from(
        `${JSON.stringify(JSON.parse(fs.readFileSync(storePath, "utf8")), null, 2).replaceAll("\n", "\r\n")}\r\n${" ".repeat(67 * 1024)}\r\n`,
      );
      fs.writeFileSync(storePath, index);
      const run = () =>
        runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
      expect((await run()).totals).toMatchObject({ importedEntries: 2, sqliteEntries: 2 });

      fs.writeFileSync(`${storePath}.replacement`, index);
      fs.renameSync(`${storePath}.replacement`, storePath);
      const retried = await run();

      expect(retried.totals).toMatchObject({ importedEntries: 0, sqliteEntries: 2 });
      expect(retried.targets.flatMap((target) => target.issues)).not.toContainEqual(
        expect.objectContaining({ code: "retained_plugin_source_conflict" }),
      );
      expect(
        retried.targets.every((target) => countBlockingSessionSqliteIssues(target) === 0),
      ).toBe(true);
      expect(fs.readFileSync(storePath)).toEqual(index);
      expect(
        loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.sessionId,
      ).toBe("legacy-kept");
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
    });
  });

  it("reports existing rows and re-verifies a changed valid index without replaying stale metadata", async () => {
    await withOpenClawTestState({ label: "retained-source-reverify" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(
        state,
        "default",
        "codex",
      );
      const options = { cfg, env: state.env, allAgents: true };
      await runDoctorSessionSqlite({ ...options, mode: "import" });
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:kept" },
        { label: "current" },
      );
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:created-after-import" },
        { sessionId: "new-canonical", updatedAt: 30, label: "current" },
      );
      fs.appendFileSync(storePath, "\r\n");
      const changedBytes = fs.readFileSync(storePath);

      const restored = await runDoctorSessionSqlite({ ...options, mode: "restore" });
      const inspected = await runDoctorSessionSqlite({ ...options, mode: "inspect" });
      expect(restored.totals.sqliteEntries).toBe(3);
      expect(restored.targets[0]?.restore?.restoredFiles).toEqual([]);
      expect(inspected.totals.sqliteEntries).toBe(3);
      expect(
        inspected.targets.every((target) => countBlockingSessionSqliteIssues(target) === 0),
      ).toBe(true);
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();

      const repaired = await runDoctorSessionSqlite({ ...options, mode: "import" });
      expect(repaired.totals).toMatchObject({ importedEntries: 0, sqliteEntries: 3 });
      expect(repaired.targets.flatMap((target) => target.issues)).toContainEqual(
        expect.objectContaining({
          code: "retained_plugin_source_index_rebuilt",
          message: expect.stringContaining(storePath),
        }),
      );
      expect(
        repaired.targets.every((target) => countBlockingSessionSqliteIssues(target) === 0),
      ).toBe(true);
      const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      fs.appendFileSync(transcript, "\r\n");
      const reverified = await runDoctorSessionSqlite({ ...options, mode: "import" });
      expect(reverified.totals).toMatchObject({ importedEntries: 0, archivedTranscriptFiles: 0 });
      expect(
        readDeferredPluginSessionImport({
          cfg,
          env: state.env,
          target: { agentId: "main", storePath },
          sqlitePath: expectDefined(repaired.targets[0]?.sqlitePath, "imported SQLite path"),
        }),
      ).toBeDefined();
      expect(fs.readFileSync(storePath)).toEqual(changedBytes);
      expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(
        "current",
      );
      expect(
        loadExactSessionEntry({ ...scope, sessionKey: "agent:main:created-after-import" })?.entry
          .label,
      ).toBe("current");
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
    });
  });

  it("reconciles a smaller retained index and reports only its differing session metadata", async () => {
    await withOpenClawTestState({ label: "retained-index-runtime-metadata" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
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
      const options = { cfg, env: state.env, allAgents: true };
      const imported = await runDoctorSessionSqlite({ ...options, mode: "import" });
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
      const recovered = await runDoctorSessionSqlite({ ...options, mode: "recover" });
      const report = expectDefined(recovered.targets[0], "recovered target");

      expect(report.sqliteEntries).toBe(12);
      expect(report.importedEntries).toBe(0);
      expect(countBlockingSessionSqliteIssues(report)).toBe(0);
      expect(readCanonical()).toEqual(canonical);
      const archive = expectDefined(report.archivedLegacyStoreFiles?.[0], "protected index");
      expect(fs.readFileSync(archive, "utf8")).toBe(changed);
      expect(fs.existsSync(storePath)).toBe(false);
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
        const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
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
        const options = { cfg, env: state.env, allAgents: true, mode: "import" as const };
        await runDoctorSessionSqlite(options);
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
        const current = loadTranscriptEventsSync({ ...scope, sessionId: "legacy-deleted" });
        fs.writeFileSync(
          transcript,
          current.map((event) => JSON.stringify(event)).join("\n") + "\n",
        );
        if (foreign) {
          fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
          fs.copyFileSync(transcript, foreignPath);
        }
        const bytes = fs.readFileSync(transcript);
        const result = await runDoctorSessionSqlite(options);
        expect(result.totals.importedEntries).toBe(0);
        expect(fs.existsSync(transcript)).toBe(false);
        const archived = expectDefined(
          result.targets[0]?.archivedTranscriptFiles[0],
          "protected shared transcript",
        );
        expect(fs.readFileSync(archived)).toEqual(bytes);
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toHaveLength(2);
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-deleted" })).toEqual(
          current,
        );
      });
    },
  );

  it("does not rebind an index that swaps existing transcript ownership", async () => {
    await withOpenClawTestState({ label: "retained-index-owner" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
      const options = { cfg, env: state.env, allAgents: true, mode: "import" as const };
      await runDoctorSessionSqlite(options);
      const events = loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" });
      const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
      entries["agent:main:kept"].sessionFile = "legacy-deleted.jsonl";
      const changed = JSON.stringify(entries);
      fs.writeFileSync(storePath, changed);
      const repaired = await runDoctorSessionSqlite(options);
      expect(repaired.totals.importedEntries).toBe(0);
      expect(fs.existsSync(storePath)).toBe(false);
      const archive = expectDefined(
        repaired.targets[0]?.archivedLegacyStoreFiles?.[0],
        "protected index archive",
      );
      expect(fs.readFileSync(archive, "utf8")).toBe(changed);
      expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toEqual(events);
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
    });
  });

  it.each([false, true])(
    "keeps a shared conflicting index until every owner is selected (truncated: %s)",
    async (truncated) => {
      await withOpenClawTestState({ label: "retained-shared-source" }, async (state) => {
        const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state);
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
        if (truncated) {
          delete entries["agent:ops:waiting"];
        }
        const changed = JSON.stringify(entries);
        fs.writeFileSync(storePath, changed);
        const partial = await runDoctorSessionSqlite({
          ...options,
          store: storePath,
          agent: "main",
        });
        expect(fs.readFileSync(storePath, "utf8")).toBe(changed);
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
        expect(completed.totals.importedEntries).toBe(truncated ? 1 : 2);
        expect(fs.existsSync(storePath)).toBe(false);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.sessionId,
        ).toBe("legacy-kept");
        expect(
          loadExactSessionEntry({ ...scope, agentId: "ops", sessionKey: "agent:ops:waiting" })
            ?.entry.sessionId,
        ).toBe(truncated ? undefined : "legacy-ops");
        if (!truncated) {
          expect(
            readDeferredPluginSessionImport({
              cfg,
              env: state.env,
              target: { agentId: "ops", storePath },
              sqlitePath: resolveSqliteTargetFromSessionStorePath(storePath, {
                agentId: "ops",
                env: state.env,
              }).path,
            }),
          ).toBeDefined();
        }
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
      });
    },
  );

  it("protects an unindexed source replaced with a later canonical transcript", async () => {
    await withOpenClawTestState({ label: "retained-unindexed-owner" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
      const source = path.join(path.dirname(storePath), "legacy-later.jsonl");
      fs.writeFileSync(source, '{"type":"custom","unimported":true}\n');
      const options = { cfg, env: state.env, allAgents: true, mode: "import" as const };
      await runDoctorSessionSqlite(options);
      const later = { ...scope, sessionKey: "agent:main:later", sessionId: "legacy-later" };
      await upsertSessionEntryCore(later, { sessionId: later.sessionId, updatedAt: 30 });
      const header = loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })[0];
      assert(isRecord(header));
      await appendTranscriptEvent(later, { ...header, id: later.sessionId });
      await appendTranscriptMessage(later, { message: { role: "user", content: "later" } });
      const events = loadTranscriptEventsSync(later);
      const replacement = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      fs.writeFileSync(source, replacement);
      const result = await runDoctorSessionSqlite(options);
      const archive = expectDefined(
        result.targets[0]?.archivedTranscriptFiles[0],
        "protected unindexed source",
      );
      expect(fs.readFileSync(archive, "utf8")).toBe(replacement);
      expect(fs.existsSync(source)).toBe(false);
      expect(loadTranscriptEventsSync(later)).toEqual(events);
      expect(result.targets.flatMap((target) => target.issues)).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("no verified indexed owner"),
        }),
      );
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
    });
  });

  it.each(["replaced-record", "removed-transcript-locator"])(
    "protects an index with a %s despite matching canonical rows",
    async (kind) => {
      await withOpenClawTestState({ label: `retained-index-${kind}` }, async (state) => {
        const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
        const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (kind === "removed-transcript-locator") {
          const nested = path.join(path.dirname(storePath), "history", "legacy-kept.jsonl");
          fs.mkdirSync(path.dirname(nested));
          fs.renameSync(path.join(path.dirname(storePath), "legacy-kept.jsonl"), nested);
          entries["agent:main:kept"].sessionFile = nested;
          fs.writeFileSync(storePath, JSON.stringify(entries));
        }
        const options = { cfg, env: state.env, allAgents: true, mode: "import" as const };
        await runDoctorSessionSqlite(options);
        if (kind === "replaced-record") {
          entries["agent:main:new"] = await upsertSessionEntryCore(
            { ...scope, sessionKey: "agent:main:new" },
            { sessionId: "new-canonical", updatedAt: 20 },
          );
          delete entries["agent:main:deleted"];
        } else {
          delete entries["agent:main:kept"].sessionFile;
        }
        const changed = JSON.stringify(entries);
        fs.writeFileSync(storePath, changed);
        const result = await runDoctorSessionSqlite(options);
        expect(result.totals.importedEntries).toBe(0);
        const archive = expectDefined(
          result.targets[0]?.archivedLegacyStoreFiles?.[0],
          "protected index",
        );
        expect(fs.readFileSync(archive, "utf8")).toBe(changed);
        expect(fs.existsSync(storePath)).toBe(false);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })?.entry.sessionId,
        ).toBe("legacy-deleted");
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
      });
    },
  );

  it.each([
    "invalid-index",
    "invalid-shared-index",
    "empty-index",
    "truncated-index",
    "conflicting-metadata",
    "missing-metadata",
    "truncated-transcript",
    "conflicting-transcript",
  ] as const)(
    "archives %s bytes for recovery without blocking canonical sessions",
    async (kind) => {
      await withOpenClawTestState({ label: `retained-source-${kind}` }, async (state) => {
        const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(
          state,
          kind === "invalid-shared-index" ? "external" : "default",
          "codex",
        );
        const options = { cfg, env: state.env, allAgents: true };
        const metadataConflict = kind === "conflicting-metadata" || kind === "missing-metadata";
        if (metadataConflict) {
          const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
          entries["agent:main:kept"].pluginExtensions = {
            codex: { fixture: { threadId: "original" } },
          };
          fs.writeFileSync(storePath, JSON.stringify(entries));
        }
        await runDoctorSessionSqlite({ ...options, mode: "import" });
        if (!metadataConflict) {
          await upsertSessionEntryCore(
            { ...scope, sessionKey: "agent:main:kept" },
            { label: "current" },
          );
        }
        const sourcePath =
          kind === "conflicting-transcript" || kind === "truncated-transcript"
            ? path.join(path.dirname(storePath), "legacy-kept.jsonl")
            : storePath;
        if (kind === "conflicting-transcript") {
          await deleteSessionEntryLifecycle({
            ...scope,
            target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
          });
        }
        const sqliteEntries = kind === "conflicting-transcript" ? 1 : 2;
        const changedMetadata = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (kind === "conflicting-metadata") {
          changedMetadata["agent:main:kept"].pluginExtensions.codex.fixture.threadId = "changed";
        } else if (kind === "missing-metadata") {
          delete changedMetadata["agent:main:kept"].pluginExtensions;
        }
        const changedBytes = Buffer.from(
          kind === "invalid-index" || kind === "invalid-shared-index"
            ? '{"agent:main:kept":\r\n'
            : kind === "empty-index"
              ? "{}"
              : kind === "truncated-transcript"
                ? fs.readFileSync(sourcePath, "utf8").split("\n")[0] + "\n"
                : kind === "conflicting-metadata" || kind === "missing-metadata"
                  ? JSON.stringify(changedMetadata)
                  : kind === "truncated-index"
                    ? JSON.stringify({
                        "agent:main:kept": JSON.parse(fs.readFileSync(storePath, "utf8"))[
                          "agent:main:kept"
                        ],
                      })
                    : fs
                        .readFileSync(sourcePath, "utf8")
                        .replace('"content":"kept"', '"content":"changed"'),
        );
        fs.writeFileSync(sourcePath, changedBytes);
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();

        const repaired = await runDoctorSessionSqlite({ ...options, mode: "import" });

        expect(repaired.totals).toMatchObject({ importedEntries: 0, sqliteEntries });
        expect(
          repaired.targets.every((target) => countBlockingSessionSqliteIssues(target) === 0),
        ).toBe(true);
        expect(repaired.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({
            code: "retained_plugin_source_conflict",
            message: expect.stringContaining(sourcePath),
          }),
        );
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
        expect(fs.readFileSync(archived.archivePath)).toEqual(changedBytes);
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe(metadataConflict ? undefined : "current");
        const events = loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" });
        expect(events).toHaveLength(2);
        expect(events).toContainEqual(
          expect.objectContaining({
            id: "kept-message",
            message: expect.objectContaining({ role: "user", content: "kept" }),
          }),
        );
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        expect(
          (await runDoctorSessionSqlite({ ...options, mode: "inspect" })).totals.sqliteEntries,
        ).toBe(sqliteEntries);
        if (kind === "conflicting-transcript") {
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "codex",
            config: cfg,
            env: state.env,
          });
          await expect(
            context.readSessionIdentityEvidenceBatch?.([
              { agentId: "main", sessionId: "legacy-deleted" },
            ]),
          ).resolves.toEqual([{ agentId: "main", sessionId: "legacy-deleted", state: "absent" }]);
        }
        expect(fs.readFileSync(archived.archivePath)).toEqual(changedBytes);
      });
    },
  );
});

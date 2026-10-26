import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  readPersistedAuthProfileStateRaw,
  writePersistedAuthProfileStateRaw,
} from "../../agents/auth-profiles/sqlite.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.test-support.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
} from "./archive-compression.js";
import { isSessionArchiveArtifactName } from "./artifacts.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  cleanupSessionLifecycleArtifactsCore,
  listSessionEntriesCore,
  loadExactSessionEntry,
  loadSessionEntry,
  loadTranscriptEvents,
  onSessionIdentityMutation,
  patchSessionEntryCore,
  publishTranscriptUpdate,
  readSessionUpdatedAtCore,
  replaceSessionEntry,
  resolveSessionTranscriptRuntimeTarget,
  updateSessionEntry,
  upsertSessionEntryCore,
  type SessionAccessScope,
  type SessionTranscriptAccessScope,
  type SessionTranscriptReadScope,
} from "./session-accessor.js";
import { listSessionEntryRows, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { observeSessionMaintenanceCompletion } from "./session-accessor.sqlite-maintenance-completion.test-support.js";
import { observeSessionMaintenanceChanges } from "./session-accessor.sqlite-maintenance.test-support.js";
import { forkSessionEntryFromParentTarget } from "./session-accessor.sqlite-parent-session.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { listSessionChildEntriesReadOnly } from "./session-entry-children-read.js";
import type { SessionEntry } from "./types.js";

// Keep accessor conformance independent of any real openclaw.json on the machine.
vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

import { getRuntimeConfig } from "../config.js";

type TestPaths = {
  sqlitePath: string;
  stateDir: string;
  storePath: string;
  tempDir: string;
};

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-accessor-conf-");

function createTestPaths(): TestPaths {
  const tempDir = sessionDirs.make();
  return {
    sqlitePath: path.join(tempDir, "openclaw-agent.sqlite"),
    stateDir: path.join(tempDir, "state"),
    storePath: path.join(tempDir, "sessions.json"),
    tempDir,
  };
}

function setMaintenance(
  maintenance: NonNullable<
    NonNullable<ReturnType<typeof getRuntimeConfig>["session"]>["maintenance"]
  >,
) {
  vi.mocked(getRuntimeConfig).mockReturnValue({ session: { maintenance } });
}

function seedEntry(scope: SessionAccessScope, entry: SessionEntry, skipMaintenance = true) {
  return patchSessionEntryCore(scope, () => entry, {
    fallbackEntry: entry,
    replaceEntry: true,
    skipMaintenance,
  });
}

function pauseEntryPatch(scope: SessionAccessScope, model: string) {
  const started = createDeferred();
  const release = createDeferred();
  const pendingPatch = patchSessionEntryCore(scope, async () => {
    started.resolve();
    await release.promise;
    return { model };
  });
  return { started: started.promise, release: release.resolve, pendingPatch };
}

const modelEntry = (sessionId: string, model: string, updatedAt = 10): SessionEntry => ({
  sessionId,
  model,
  updatedAt,
});

function appendTrajectory(storePath: string, sessionId: string, type: string) {
  appendSqliteTrajectoryRuntimeEvents({ sessionId, storePath }, [
    {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId: sessionId,
      source: "runtime",
      type,
      ts: "2026-07-09T00:00:00.000Z",
      seq: 1,
      sessionId,
    },
  ]);
}

function readArchive(file: string) {
  return readSessionArchiveContentSync(file)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

type AccessorAdapter = typeof publicAccessorAdapter;

const publicAccessorAdapter = {
  name: "public-accessor",
  entryScope: (paths: TestPaths): SessionAccessScope => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionKey: "agent:main:main",
    storePath: paths.sqlitePath,
  }),
  transcriptScope: (paths: TestPaths, id = "session-1"): SessionTranscriptAccessScope => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionId: id,
    sessionKey: "agent:main:main",
    storePath: paths.sqlitePath,
  }),
  transcriptReadScope: (paths: TestPaths, id = "session-1"): SessionTranscriptReadScope => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionId: id,
    storePath: paths.sqlitePath,
  }),
  loadSessionEntry,
  loadExactSessionEntry,
  listSessionEntriesCore,
  readSessionUpdatedAtCore,
  upsertSessionEntry: upsertSessionEntryCore,
  replaceSessionEntry,
  patchSessionEntryCore,
  updateSessionEntry,
  cleanupSessionLifecycleArtifactsCore,
  loadTranscriptEvents,
  appendTranscriptEvent,
  appendTranscriptMessage,
  publishTranscriptUpdate,
};

const sqliteAdapter: AccessorAdapter = {
  ...publicAccessorAdapter,
  name: "sqlite",
  listSessionEntriesCore: listSessionEntryRows,
  updateSessionEntry: patchSessionEntryCore,
};

beforeEach(() => {
  vi.mocked(getRuntimeConfig).mockReturnValue({});
});

afterEach(() => {
  vi.mocked(getRuntimeConfig).mockReset();
});

describe.each([publicAccessorAdapter, sqliteAdapter])(
  "session accessor conformance: $name",
  (adapter) => {
    let paths: TestPaths;
    // Register direct SQLite cases only once instead of once per adapter row.
    const t = (name: string, run: () => Promise<void>) => {
      if (adapter === sqliteAdapter) {
        it(name, run);
      }
    };

    beforeEach(() => {
      paths = createTestPaths();
    });

    afterEach(async () => {
      await closeOpenClawAgentDatabasesAsync(paths.tempDir);
    });

    it("conforms for entry load/list/timestamp/upsert/update/replace/patch", async () => {
      const scope = adapter.entryScope(paths);

      await adapter.upsertSessionEntry(scope, modelEntry("session-1", "gpt-5.5"));

      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: expect.any(Number),
      });
      expect(adapter.readSessionUpdatedAtCore(scope)).toEqual(expect.any(Number));
      expect(adapter.listSessionEntriesCore(scope)).toEqual([
        {
          sessionKey: "agent:main:main",
          entry: expect.objectContaining({ model: "gpt-5.5", sessionId: "session-1" }),
        },
      ]);

      await expect(
        adapter.updateSessionEntry(scope, () => ({ model: "sonnet-4.6", updatedAt: 20 })),
      ).resolves.toMatchObject({ model: "sonnet-4.6", sessionId: "session-1" });

      await adapter.replaceSessionEntry(scope, {
        providerOverride: "openai",
        sessionId: "session-1",
        updatedAt: 30,
      });

      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        providerOverride: "openai",
        sessionId: "session-1",
      });
      expect(adapter.loadSessionEntry(scope)?.model).toBeUndefined();

      let existingContext: SessionEntry | undefined;
      await adapter.patchSessionEntryCore(
        scope,
        (entry, context) => {
          existingContext = context.existingEntry;
          return { ...entry, model: "gpt-5.5" };
        },
        { replaceEntry: true },
      );

      expect(existingContext).toMatchObject({ providerOverride: "openai" });
      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        model: "gpt-5.5",
        sessionId: "session-1",
      });

      const beforePreservePatch = adapter.loadSessionEntry(scope);
      await adapter.patchSessionEntryCore(
        scope,
        () => ({ providerOverride: "anthropic", updatedAt: 40 }),
        { preserveActivity: true },
      );

      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        model: "gpt-5.5",
        providerOverride: "anthropic",
        sessionId: "session-1",
        updatedAt: beforePreservePatch?.updatedAt,
      });
    });

    t("reads the exact timestamp without selecting or decoding cold snapshots", async () => {
      const scope = adapter.entryScope(paths);
      replaceSessionEntrySync(scope, {
        sessionId: "timestamp-target",
        updatedAt: 42,
        skillsSnapshot: { prompt: `TIMESTAMP_COLD_PAYLOAD_${"x".repeat(65_536)}`, skills: [] },
      });
      const queries: string[] = [];
      const reads = observeMainThreadSql({ onStatement: (sql) => queries.push(sql) });
      const parse = vi.spyOn(JSON, "parse");
      try {
        expect(adapter.readSessionUpdatedAtCore(scope)).toBe(42);
        const nodeQueries = queries.filter((sql) => /from "session_nodes"/i.test(sql));
        expect(nodeQueries).toHaveLength(1);
        expect.soft(nodeQueries.some((sql) => sql.includes("session_entry_snapshots"))).toBe(false);
        expect(parse.mock.calls.some(([value]) => value.includes("TIMESTAMP_COLD_PAYLOAD_"))).toBe(
          false,
        );
      } finally {
        parse.mockRestore();
        reads.restore();
      }
    });

    t("conforms for exact persisted-key lookup without canonical alias fallback", async () => {
      const scope = adapter.entryScope(paths);
      const mixedCaseScope = { ...scope, sessionKey: "AGENT:MAIN:MAIN" };

      await adapter.upsertSessionEntry(scope, modelEntry("exact-session", "gpt-5.5"));

      expect(adapter.loadSessionEntry(mixedCaseScope)).toMatchObject({
        model: "gpt-5.5",
        sessionId: "exact-session",
      });
      expect(adapter.loadExactSessionEntry(mixedCaseScope)).toBeUndefined();
      expect(adapter.loadExactSessionEntry(scope)).toEqual({
        sessionKey: "agent:main:main",
        entry: expect.objectContaining({ model: "gpt-5.5", sessionId: "exact-session" }),
      });
    });

    t("conforms for lifecycle entry and transcript cleanup", async () => {
      const nowMs = Date.now();
      const oldTimestamp = nowMs - 600_000;
      const cleanupStorePath = path.join(
        paths.stateDir,
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const scopedEntry = (sessionKey: string): SessionAccessScope => ({
        ...adapter.entryScope(paths),
        sessionKey,
        storePath: cleanupStorePath,
      });
      const scopedTranscript = (
        sessionKey: string,
        sessionId: string,
      ): SessionTranscriptAccessScope => ({
        ...adapter.transcriptScope(paths, sessionId),
        sessionKey,
        storePath: cleanupStorePath,
      });
      for (const [sessionKey, sessionId, updatedAt] of [
        ["agent:main:lifecycle-cleanup-missing", "missing-lifecycle", oldTimestamp],
        ["agent:main:lifecycle-cleanup-removed", "removed-lifecycle", oldTimestamp],
        ["agent:main:lifecycle-cleanup-fresh", "fresh-lifecycle", nowMs],
        ["agent:main:telegram:group:lifecycle-cleanup-room", "kept-by-segment", oldTimestamp],
        ["agent:main:regular", "referenced", oldTimestamp],
      ] as const) {
        await adapter.replaceSessionEntry(scopedEntry(sessionKey), { sessionId, updatedAt });
      }
      for (const [sessionKey, sessionId, timestamp] of [
        ["agent:main:lifecycle-cleanup-removed", "removed-lifecycle", oldTimestamp],
        ["agent:main:lifecycle-cleanup-fresh", "fresh-lifecycle", nowMs],
        ["agent:main:regular", "referenced", oldTimestamp],
        ["agent:main:orphan", "orphan-lifecycle", oldTimestamp],
      ] as const) {
        await adapter.appendTranscriptEvent(scopedTranscript(sessionKey, sessionId), {
          id: `${sessionId}-event`,
          marker: "lifecycle-marker-run",
          timestamp: new Date(timestamp).toISOString(),
          type: "metadata",
        });
      }

      for (const sessionKey of [
        "agent:main:lifecycle-cleanup-missing",
        "agent:main:lifecycle-cleanup-removed",
        "agent:main:telegram:group:lifecycle-cleanup-room",
        "agent:main:regular",
      ]) {
        expect(adapter.readSessionUpdatedAtCore(scopedEntry(sessionKey))).toBe(oldTimestamp);
      }
      expect(
        adapter.readSessionUpdatedAtCore(scopedEntry("agent:main:lifecycle-cleanup-fresh")),
      ).toBe(nowMs);

      await expect(
        adapter.cleanupSessionLifecycleArtifactsCore({
          env: adapter.entryScope(paths).env,
          storePath: cleanupStorePath,
          sessionKeySegmentPrefix: "lifecycle-cleanup-",
          transcriptContentMarker: "lifecycle-marker-",
          orphanTranscriptMinAgeMs: 300_000,
          nowMs,
        }),
      ).resolves.toEqual({ removedEntries: 2, archivedTranscriptArtifacts: 1 });

      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-missing")),
      ).toBeUndefined();
      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-removed")),
      ).toBeUndefined();
      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-fresh")),
      ).toMatchObject({ sessionId: "fresh-lifecycle" });
      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:telegram:group:lifecycle-cleanup-room")),
      ).toMatchObject({ sessionId: "kept-by-segment" });
      expect(adapter.loadSessionEntry(scopedEntry("agent:main:regular"))).toMatchObject({
        sessionId: "referenced",
      });
      expect(fs.existsSync(cleanupStorePath)).toBe(false);
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
        path: path.join(paths.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      });
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
      const readRoute = (sessionKey: string) =>
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select("current_session_id")
            .where("session_key", "=", sessionKey),
        );
      expect(readRoute("agent:main:lifecycle-cleanup-removed")).toBeUndefined();
      expect(readRoute("agent:main:lifecycle-cleanup-fresh")).toEqual({
        current_session_id: "fresh-lifecycle",
      });
      await expect(
        adapter.loadTranscriptEvents(scopedTranscript("agent:main:regular", "referenced")),
      ).resolves.not.toEqual([]);
      await expect(
        adapter.loadTranscriptEvents(
          scopedTranscript("agent:main:lifecycle-cleanup-removed", "removed-lifecycle"),
        ),
      ).resolves.toEqual([]);
      const files = fs.readdirSync(path.dirname(cleanupStorePath));
      const removedArchive = files.find((file) =>
        file.startsWith("removed-lifecycle.jsonl.deleted."),
      );
      const orphanArchive = files.find((file) =>
        file.startsWith("orphan-lifecycle.jsonl.deleted."),
      );
      expect(removedArchive).toBeDefined();
      // Route-referenced orphan history is retained in SQLite, not archived.
      expect(orphanArchive).toBeUndefined();
      await expect(
        adapter.loadTranscriptEvents(scopedTranscript("agent:main:orphan", "orphan-lifecycle")),
      ).resolves.not.toEqual([]);
      expect(readArchive(path.join(path.dirname(cleanupStorePath), removedArchive ?? ""))).toEqual([
        expect.objectContaining({ id: "removed-lifecycle-event", marker: "lifecycle-marker-run" }),
      ]);
    });

    t("conforms for raw transcript event load and append", async () => {
      const scope = adapter.transcriptScope(paths);
      const readScope = adapter.transcriptReadScope(paths);
      const event = {
        id: "event-1",
        parentId: null,
        payload: { content: "hello" },
        type: "metadata",
      };

      await adapter.appendTranscriptEvent(scope, { type: "session", sessionId: "session-1" });
      await adapter.appendTranscriptEvent(scope, event);

      await expect(adapter.loadTranscriptEvents(readScope)).resolves.toEqual([
        { type: "session", sessionId: "session-1" },
        event,
      ]);
      expect(loadTranscriptEventsSync(readScope)).toEqual([
        { type: "session", sessionId: "session-1" },
        event,
      ]);
    });

    if (adapter === sqliteAdapter) {
      it.each(["canonical", "custom"] as const)(
        "maps %s JSON paths to the agent SQLite database",
        async (kind) => {
          const canonical = kind === "canonical";
          const storePath = canonical
            ? path.join(paths.stateDir, "agents", "voice", "sessions", "sessions.json")
            : path.join(paths.tempDir, "custom-sessions.json");
          const sqlitePath = canonical
            ? path.join(paths.stateDir, "agents", "voice", "agent", "openclaw-agent.sqlite")
            : path.join(paths.tempDir, "custom-sessions.voice.sqlite");
          const scope = {
            env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
            sessionKey: canonical ? "agent:voice:voice:123" : "agent:voice:main",
            storePath,
          };
          await upsertSessionEntryCore(scope, modelEntry("session-1", "gpt-5.5"));
          expect(
            loadSessionEntry({ ...scope, agentId: "voice", storePath: sqlitePath }),
          ).toMatchObject({ model: "gpt-5.5", sessionId: "session-1" });
          expect([fs.existsSync(sqlitePath), fs.existsSync(storePath)]).toEqual([true, false]);
          if (canonical) {
            expect(listSessionEntryRows({ env: scope.env, storePath: sqlitePath })).toEqual([
              expect.objectContaining({
                entry: expect.objectContaining({ sessionId: "session-1" }),
                sessionKey: "agent:voice:voice:123",
              }),
            ]);
            expect(() =>
              loadSessionEntry({ ...scope, agentId: "main", storePath: sqlitePath }),
            ).toThrow("belongs to agent voice; requested agent main");
          }
        },
      );
    }

    t("uses the requested agent for custom sessions.json SQLite targets", async () => {
      const customStorePath = path.join(paths.tempDir, "custom-store", "sessions.json");
      const customSqlitePath = path.join(
        path.dirname(customStorePath),
        "openclaw-agent.support.sqlite",
      );
      const scope = {
        agentId: "support",
        env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
        sessionKey: "agent:support:main",
        storePath: customStorePath,
      };

      await upsertSessionEntryCore(scope, modelEntry("support-session", "gpt-5.5"));
      const runtimeTarget = await resolveSessionTranscriptRuntimeTarget({
        ...scope,
        sessionId: "support-session",
      });

      expect(loadSessionEntry({ ...scope, storePath: customSqlitePath })).toMatchObject({
        model: "gpt-5.5",
        sessionId: "support-session",
      });
      expect(fs.existsSync(customSqlitePath)).toBe(true);
      expect(runtimeTarget).toMatchObject({
        agentId: "support",
        sessionId: "support-session",
        sessionKey: scope.sessionKey,
        storePath: customStorePath,
      });
    });

    t("parses only the selected SQLite entry across keyed loads", async () => {
      const scope = sqliteAdapter.entryScope(paths);
      for (let index = 0; index < 20; index += 1) {
        await upsertSessionEntryCore(
          { ...scope, sessionKey: `agent:main:unrelated-${index}` },
          modelEntry(`unrelated-session-${index}`, `model-${index}`, index + 1),
        );
      }
      await upsertSessionEntryCore(scope, modelEntry("target-session", "target", 100));
      const parseSpy = vi.spyOn(JSON, "parse");
      const targetEntryParseCount = () =>
        parseSpy.mock.calls.filter(
          ([json]) =>
            typeof json === "string" &&
            json.includes('"sessionId":"target-session"') &&
            json.includes('"model":"target"'),
        ).length;

      try {
        expect(loadSessionEntry(scope)).toMatchObject({
          model: "target",
          sessionId: "target-session",
        });
        expect(targetEntryParseCount()).toBe(1);
        expect(
          parseSpy.mock.calls.some(
            ([json]) =>
              typeof json === "string" && json.includes('"sessionId":"unrelated-session-'),
          ),
        ).toBe(false);
        expect(loadSessionEntry(scope)).toMatchObject({
          model: "target",
          sessionId: "target-session",
        });
        expect(targetEntryParseCount()).toBe(2);
      } finally {
        parseSpy.mockRestore();
      }
    });

    t("archives stale SQLite entries below the entry cap on ordinary writes", async () => {
      const scope = sqliteAdapter.entryScope(paths);
      const staleScope = { ...scope, sessionKey: "agent:main:stale-under-cap" };
      const staleEntry = {
        model: "stale",
        sessionId: "stale-under-cap",
        updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      };
      await seedEntry(staleScope, staleEntry);

      const maintained = observeSessionMaintenanceChanges(paths.sqlitePath, staleScope.sessionKey);
      await upsertSessionEntryCore(scope, modelEntry("fresh-session", "fresh", Date.now()));

      await maintained;
      expect(loadSessionEntry(staleScope)).toMatchObject({
        ...staleEntry,
        archivedAt: expect.any(Number),
        archiveReason: "age-retention",
      });
      expect(loadSessionEntry(scope)).toMatchObject({ model: "fresh", sessionId: "fresh-session" });
    });

    t("serializes concurrent SQLite entry patches", async () => {
      const scope = sqliteAdapter.entryScope(paths);

      await upsertSessionEntryCore(scope, modelEntry("patch-session", "base"));

      const {
        started,
        release: releasePatch,
        pendingPatch: firstPatch,
      } = pauseEntryPatch(scope, "first");
      await started;
      const secondPatch = patchSessionEntryCore(scope, () => ({ providerOverride: "openai" }));
      releasePatch();
      await Promise.all([firstPatch, secondPatch]);

      expect(loadSessionEntry(scope)).toMatchObject({ model: "first", providerOverride: "openai" });
    });

    t("does not hold a write transaction while awaiting a SQLite entry updater", async () => {
      const scope = sqliteAdapter.entryScope(paths);
      await replaceSessionEntry(scope, modelEntry("transaction-gap", "base"));

      const { started, release: releaseUpdater, pendingPatch } = pauseEntryPatch(scope, "patched");
      await started;
      let unrelatedWriteError: unknown;
      try {
        appendTrajectory(paths.sqlitePath, "transaction-gap", "test.concurrent-write");
      } catch (error) {
        unrelatedWriteError = error;
      } finally {
        releaseUpdater();
      }

      await expect(pendingPatch).resolves.toMatchObject({ model: "patched" });
      expect(unrelatedWriteError).toBeUndefined();
    });

    t("allows auth and trajectory writers while a session updater is preparing", async () => {
      const agentDir = path.join(paths.tempDir, "agents", "main", "agent");
      const conventionalStorePath = path.join(
        paths.tempDir,
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:shared-writers",
        storePath: conventionalStorePath,
      };
      await replaceSessionEntry(scope, modelEntry("shared-writers", "base"));

      const { started, release: releaseUpdater, pendingPatch } = pauseEntryPatch(scope, "patched");
      await started;
      writePersistedAuthProfileStateRaw({ selectedProfile: "test" }, agentDir);
      appendTrajectory(conventionalStorePath, "shared-writers", "test.shared-writers");
      releaseUpdater();

      await expect(pendingPatch).resolves.toMatchObject({ model: "patched" });
      expect(readPersistedAuthProfileStateRaw(agentDir)).toEqual({ selectedProfile: "test" });
    });

    t("rejects a prepared SQLite entry patch when its source row changes", async () => {
      const scope = sqliteAdapter.entryScope(paths);
      await replaceSessionEntry(scope, modelEntry("stale-prepare", "base"));

      const patch = pauseEntryPatch(scope, "stale-patch");
      const { started, release: releaseUpdater, pendingPatch } = patch;
      await started;
      let replacementError: unknown;
      try {
        replaceSessionEntrySync(scope, {
          model: "newer",
          sessionId: "stale-prepare",
          updatedAt: 20,
        });
      } catch (error) {
        replacementError = error;
      } finally {
        releaseUpdater();
      }
      const mutationError = await pendingPatch.then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(replacementError).toBeUndefined();
      expect(mutationError).toMatchObject({ name: "SqliteSessionMutationConflictError" });
      expect(loadSessionEntry(scope)).toMatchObject({ model: "newer", updatedAt: 20 });
    });

    t("dedupes SQLite transcript identities inside the writer path", async () => {
      const scope = sqliteAdapter.transcriptScope(paths, "session-dedupe");
      const event = { id: "event-dedupe", source: "conformance", type: "metadata" };

      await appendTranscriptEvent(scope, event);
      await appendTranscriptEvent(scope, {
        ...event,
        message: { role: "assistant", content: "duplicate" },
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          appendTranscriptMessage(scope, {
            idempotencyLookup: "scan",
            message: { role: "assistant", content: "keyed", idempotencyKey: "keyed-once" },
          }),
        ),
      );

      expect(new Set(results.map((result) => result?.messageId)).size).toBe(1);
      expect(results.filter((result) => result?.appended)).toHaveLength(1);
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        event,
        expect.objectContaining({
          message: expect.objectContaining({ idempotencyKey: "keyed-once" }),
          parentId: null,
          type: "message",
        }),
      ]);
    });

    t("rejects raw message transcript event writes", async () => {
      const scope = adapter.transcriptScope(paths, "session-raw-message");
      await expect(
        adapter.appendTranscriptEvent(scope, {
          id: "raw-message",
          message: { role: "assistant", content: "raw" },
          parentId: null,
          type: "message",
        }),
      ).rejects.toThrow(/use append(?:Sqlite)?TranscriptMessage instead/);
    });

    t(
      "rejects conflicting SQLite transcript messages after default idempotency dedupe",
      async () => {
        const scope = sqliteAdapter.transcriptScope(paths, "session-unchecked-dedupe");
        const message = {
          role: "assistant",
          content: "unchecked",
          idempotencyKey: "unchecked-once",
        };

        const appended = await appendTranscriptMessage(scope, { message });
        const replayed = await appendTranscriptMessage(scope, { message });
        await expect(
          appendTranscriptMessage(scope, {
            message: { ...message, content: "unchecked replay" },
          }),
        ).rejects.toThrow(/conflicts with the admitted message/u);

        const events = await loadTranscriptEvents(scope);
        const keyedEvents = events.filter((event): event is { message: typeof message } => {
          return (
            Boolean(event) &&
            typeof event === "object" &&
            !Array.isArray(event) &&
            (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
              "unchecked-once"
          );
        });
        expect(appended).toMatchObject({ appended: true });
        expect(replayed).toMatchObject({
          appended: false,
          message: expect.objectContaining({ content: "unchecked" }),
          messageId: appended?.messageId,
        });
        expect(keyedEvents).toHaveLength(1);
      },
    );

    t("treats replayed SQLite transcript message ids as existing appends", async () => {
      const scope = sqliteAdapter.transcriptScope(paths, "session-event-id-dedupe");
      const eventId = "message-retry-event-id";

      const options = { eventId, message: { role: "assistant", content: "first attempt" } };
      const appended = await appendTranscriptMessage(scope, options);
      const replayed = await appendTranscriptMessage(scope, options);
      await expect(
        appendTranscriptMessage(scope, {
          eventId,
          message: { role: "assistant", content: "retry attempt" },
        }),
      ).rejects.toThrow(/conflicts with the admitted message/u);

      expect(appended).toMatchObject({ appended: true, messageId: eventId });
      expect(replayed).toMatchObject({
        appended: false,
        message: expect.objectContaining({ content: "first attempt" }),
        messageId: eventId,
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session" }),
        expect.objectContaining({
          id: eventId,
          message: expect.objectContaining({ content: "first attempt" }),
          type: "message",
        }),
      ]);
    });

    t("conforms for transcript message append, idempotency, and update publication", async () => {
      const scope = adapter.transcriptScope(paths, "session-2");
      const updates: unknown[] = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        updates.push(update);
      });
      onTestFinished(unsubscribe);

      const options = {
        cwd: paths.tempDir,
        idempotencyLookup: "scan" as const,
        message: { role: "assistant", content: "hello", idempotencyKey: "assistant-once" },
      };
      const appended = await adapter.appendTranscriptMessage(scope, options);
      const replayed = await adapter.appendTranscriptMessage(scope, options);
      await adapter.publishTranscriptUpdate(scope, {
        agentId: "main",
        message: appended?.message,
        messageId: appended?.messageId,
        sessionKey: scope.sessionKey,
      });
      unsubscribe();

      expect(appended).toMatchObject({
        anchor: {
          entryId: expect.any(String),
          agentId: "main",
          activeMessagePosition: expect.any(Number),
          effectiveParentId: null,
          generation: expect.any(String),
          idempotencyKey: "assistant-once",
          rawSeq: expect.any(Number),
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
          storePath: expect.stringContaining("openclaw-agent.sqlite"),
        },
        appended: true,
        message: expect.objectContaining({ content: "hello" }),
        messageId: expect.any(String),
      });
      expect(replayed).toMatchObject({
        anchor: appended?.anchor,
        appended: false,
        message: expect.objectContaining({ content: "hello", idempotencyKey: "assistant-once" }),
        messageId: appended?.messageId,
      });
      expect(replayed?.anchor).toBeDefined();
      expect(replayed?.anchor).toEqual(appended?.anchor);
      await expect(
        adapter.appendTranscriptMessage(scope, {
          cwd: paths.tempDir,
          idempotencyLookup: "scan",
          message: {
            role: "assistant",
            content: "conflicting replay",
            idempotencyKey: "assistant-once",
          },
        }),
      ).rejects.toThrow(/conflicts with the admitted message/u);
      await expect(adapter.loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session" }),
        expect.objectContaining({
          id: appended?.messageId,
          message: expect.objectContaining({ content: "hello" }),
          type: "message",
        }),
      ]);
      expect(updates).toEqual([
        expect.objectContaining({
          agentId: "main",
          message: appended?.message,
          messageId: appended?.messageId,
          sessionKey: scope.sessionKey,
        }),
      ]);
    });
  },
);

describe("sqlite session normalization", () => {
  let paths: TestPaths;
  let env: NodeJS.ProcessEnv;
  const storeScope = () => ({ agentId: "main", env, storePath: paths.sqlitePath });
  const scopeFor = (sessionKey: string, storePath = paths.sqlitePath): SessionAccessScope => ({
    agentId: "main",
    env,
    sessionKey,
    storePath,
  });
  const databaseFor = () =>
    openOpenClawAgentDatabase({ agentId: "main", env, path: paths.sqlitePath });

  beforeEach(() => {
    paths = createTestPaths();
    env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
  });

  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync(paths.tempDir);
  });

  it("maintains normalized session node and window rows", async () => {
    await upsertSessionEntryCore(scopeFor("agent:main:group:example"), {
      agentHarnessId: "codex",
      chatType: "group",
      delivery: normalizeSessionDeliveryState({
        context: { accountId: "acct-1", channel: "discord", threadId: "thread-1", to: "group-1" },
      }),
      displayName: "Example group",
      endedAt: 90,
      model: "gpt-5.5",
      modelProvider: "openai",
      parentSessionKey: "agent:main:parent",
      sessionId: "normalized-session",
      sessionStartedAt: 50,
      spawnedBy: "agent:main:spawner",
      startedAt: 60,
      status: "done",
      updatedAt: 100,
    });

    const database = databaseFor();
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const session = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_windows")
        .select([
          "account_id",
          "agent_harness_id",
          "channel",
          "chat_type",
          "created_at",
          "display_name",
          "ended_at",
          "model",
          "model_provider",
          "parent_session_key",
          "session_key",
          "session_scope",
          "spawned_by",
          "started_at",
          "status",
          "updated_at",
        ])
        .where("session_id", "=", "normalized-session"),
    );
    expect(session).toEqual({
      account_id: "acct-1",
      agent_harness_id: "codex",
      channel: "discord",
      chat_type: "group",
      created_at: 50,
      display_name: "Example group",
      ended_at: 90,
      model: "gpt-5.5",
      model_provider: "openai",
      parent_session_key: "agent:main:parent",
      session_key: "agent:main:group:example",
      session_scope: "group",
      spawned_by: "agent:main:spawner",
      started_at: 60,
      status: "done",
      updated_at: expect.any(Number),
    });

    const route = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select(["current_session_id", "updated_at"])
        .where("session_key", "=", "agent:main:group:example"),
    );
    expect(route).toEqual({
      current_session_id: "normalized-session",
      updated_at: expect.any(Number),
    });
  });

  it("writes a valid session beside an unrelated malformed legacy row", async () => {
    const database = databaseFor();
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, -1, ?)",
      )
      .run("agent:main:malformed", "malformed-session", "{ malformed", 0);

    await expect(
      replaceSessionEntry(scopeFor("agent:main:valid"), {
        sessionId: "valid-session",
        updatedAt: Date.now(),
      }),
    ).resolves.toMatchObject({ sessionId: "valid-session" });
    expect(
      database.db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get("agent:main:malformed"),
    ).toEqual({ entry_json: "{ malformed" });
  });

  it("exposes same-key rollover lineage when a killed session is replaced", async () => {
    const sessionKey = "agent:main:telegram:group:-1003774691294:topic:29020";
    const oldSessionId = "f1321535-878b-47cd-b35e-2f5f4bae2bb5";
    const newSessionId = "c0daccb0-0555-47d8-8747-9b53addf1fe2";
    const scope = scopeFor(sessionKey);

    await upsertSessionEntryCore(scope, {
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
      chatType: "group",
      createdVia: "channel",
      createdActor: { type: "human", source: "channel", id: "telegram-sender" },
      createdAt: 1_782_973_390_000,
      displayName: "telegram:g-bucephalus-+-topics",
      forkSource: { sessionKey: "agent:main:main", sessionId: "root-session" },
      sessionId: oldSessionId,
      status: "killed",
      updatedAt: 1_782_973_392_492,
    });
    await appendTranscriptEvent(
      { ...scope, sessionId: oldSessionId },
      { id: "old-frontier", payload: { label: "old transcript frontier" }, type: "metadata" },
    );

    await upsertSessionEntryCore(scope, {
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
      chatType: "group",
      displayName: "telegram:g-bucephalus-+-topics",
      sessionId: newSessionId,
      status: undefined,
      updatedAt: 1_782_997_881_018,
    });
    await appendTranscriptEvent(
      { ...scope, sessionId: newSessionId },
      { id: "new-turn", payload: { label: "new active turn" }, type: "metadata" },
    );

    await expect(loadTranscriptEvents({ ...scope, sessionId: oldSessionId })).resolves.toEqual([
      expect.objectContaining({ id: "old-frontier", type: "metadata" }),
    ]);
    await expect(loadTranscriptEvents({ ...scope, sessionId: newSessionId })).resolves.toEqual([
      expect.objectContaining({ id: "new-turn", type: "metadata" }),
    ]);
    expect(loadSessionEntry(scope)).toEqual(
      expect.objectContaining({
        sessionId: newSessionId,
        createdVia: "channel",
        createdActor: { type: "human", source: "channel", id: "telegram-sender" },
        createdAt: 1_782_973_390_000,
        forkSource: { sessionKey: "agent:main:main", sessionId: "root-session" },
        previousSessionId: oldSessionId,
        usageFamilyKey: sessionKey,
        usageFamilySessionIds: [oldSessionId, newSessionId],
      }),
    );
  });

  it("keeps exact SQLite replacement entries free of inferred rollover lineage", async () => {
    const scope = scopeFor("agent:main:restore-exact");

    await upsertSessionEntryCore(scope, { sessionId: "temporary-session", updatedAt: 10 });
    await replaceSessionEntry(scope, { sessionId: "restored-session", updatedAt: 20 });

    expect(loadSessionEntry(scope)).toEqual({
      sessionId: "restored-session",
      updatedAt: 20,
      delivery: { kind: "none" },
    });
  });

  it("skips parent fork when transcript rows exceed the token budget and entry totals are stale", async () => {
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:subagent:child";
    await upsertSessionEntryCore(scopeFor(parentKey), {
      sessionId: "parent-session",
      totalTokens: 1,
      totalTokensFresh: false,
      updatedAt: 10,
    });
    await replaceTranscriptEvents({ ...scopeFor(parentKey), sessionId: "parent-session" }, [
      { type: "session", id: "parent-session", cwd: paths.tempDir },
      {
        type: "message",
        id: "oversized-parent",
        parentId: null,
        message: { role: "user", content: "x".repeat(420_000) },
      },
    ]);

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: paths.stateDir }, () =>
      forkSessionEntryFromParentTarget({
        fallbackEntry: { sessionId: "", updatedAt: 1 },
        parentTarget: { canonicalKey: parentKey, storeKeys: [parentKey] },
        sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
        storePath: paths.sqlitePath,
      }),
    );

    expect(result).toMatchObject({
      status: "skipped",
      reason: "decision-skip",
      decision: { status: "skip", reason: "parent-too-large" },
      sessionEntry: { sessionId: "", updatedAt: 1 },
    });
    if (result.status !== "skipped" || result.reason !== "decision-skip") {
      throw new Error(`expected decision-skip, got ${result.status}`);
    }
    expect(result.decision?.parentTokens).toBeGreaterThan(100_000);
  });

  it("does not move current nodes back to stale transcript session ids", async () => {
    const scope = scopeFor("agent:main:main");
    await upsertSessionEntryCore(scope, { sessionId: "current-session", updatedAt: 20 });
    await appendTranscriptEvent(
      { ...scope, sessionId: "stale-session" },
      { id: "stale-event", timestamp: new Date(10).toISOString(), type: "metadata" },
    );

    const database = databaseFor();
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const route = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select("current_session_id")
        .where("session_key", "=", "agent:main:main"),
    );
    expect(route).toEqual({ current_session_id: "current-session" });
  });

  it("applies SQLite session-entry maintenance after entry writes", async () => {
    setMaintenance({ mode: "enforce", pruneAfter: "1d", maxEntries: 2 });
    const oldUpdatedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;

    for (const [key, updatedAt] of [
      ["stale", oldUpdatedAt],
      ["older", oldUpdatedAt + 1],
      ["active", Date.now()],
    ] as const) {
      const entry = { sessionId: `${key}-session`, updatedAt };
      await seedEntry(scopeFor(`agent:main:${key === "active" ? key : `subagent:${key}`}`), entry);
    }
    const staleTranscriptEvent = {
      id: "stale-event",
      timestamp: new Date(oldUpdatedAt).toISOString(),
      type: "metadata",
    };
    await appendTranscriptEvent(
      { ...scopeFor("agent:main:subagent:stale"), sessionId: "stale-session" },
      staleTranscriptEvent,
    );
    // A publisher's temporary file must not satisfy the archive-ready check.
    const pendingArchive = encodeSessionArchiveContent('{"id":"unpublished-event"}\n');
    fs.writeFileSync(
      path.join(
        paths.tempDir,
        `stale-session.jsonl.deleted.2026-09-02T00-00-00.000Z${pendingArchive.suffix}.f758980d-fd32-4cf1-8946-720e29457bfb.tmp`,
      ),
      pendingArchive.bytes,
    );

    await patchSessionEntryCore(scopeFor("agent:main:active"), () => ({ model: "gpt-5.5" }), {
      skipMaintenance: true,
    });
    await expect(
      loadTranscriptEvents({ ...storeScope(), sessionId: "stale-session" }),
    ).resolves.toEqual([staleTranscriptEvent]);
    expect(listSessionEntryRows(storeScope()).map((summary) => summary.sessionKey)).toEqual([
      "agent:main:active",
      "agent:main:subagent:older",
      "agent:main:subagent:stale",
    ]);

    const notify = vi.fn();
    const unsubscribe = onSessionIdentityMutation(notify);
    onTestFinished(unsubscribe);
    const maintained = observeSessionMaintenanceCompletion(paths.sqlitePath);
    await patchSessionEntryCore(scopeFor("agent:main:active"), () => ({
      providerOverride: "openai",
    }));
    await maintained;
    expect(new Set(notify.mock.calls.map(([mutation]) => mutation.previous.sessionId))).toEqual(
      new Set(["older-session", "stale-session"]),
    );
    const archivedStale = fs
      .readdirSync(paths.tempDir)
      .filter(
        (file) =>
          file.startsWith("stale-session.jsonl.deleted.") && isSessionArchiveArtifactName(file),
      );
    expect(archivedStale).toHaveLength(1);
    unsubscribe();
    expect(listSessionEntryRows(storeScope()).map((summary) => summary.sessionKey)).toEqual([
      "agent:main:active",
    ]);
    await expect(
      loadTranscriptEvents({ ...storeScope(), sessionId: "stale-session" }),
    ).resolves.toEqual([]);
    expect(readArchive(path.join(paths.tempDir, archivedStale[0] ?? ""))).toEqual([
      staleTranscriptEvent,
    ]);

    await seedEntry(scopeFor("agent:main:newer"), {
      sessionId: "newer-session",
      updatedAt: Date.now() + 1,
    });
    const capped = observeSessionMaintenanceChanges(paths.sqlitePath, "agent:main:active");
    await seedEntry(
      scopeFor("agent:main:newest"),
      { sessionId: "newest-session", updatedAt: Date.now() + 2 },
      false,
    );

    await capped;
    expect(listSessionEntryRows(storeScope()).map((summary) => summary.sessionKey)).toEqual([
      "agent:main:active",
      "agent:main:newer",
      "agent:main:newest",
    ]);
    expect(loadSessionEntry(scopeFor("agent:main:active"))?.archivedAt).toEqual(expect.any(Number));
  });

  it("commits unrelated channel sessions without invoking stored channel plugin resolvers", async () => {
    setMaintenance({ mode: "enforce", pruneAfter: "1d", maxEntries: 2 });
    const storedKey = "agent:main:broken:group:room:thread:reply";
    const storedEntry = {
      sessionId: "stored-channel-session",
      updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    };
    await seedEntry(scopeFor(storedKey), storedEntry);

    const resolveSessionConversation = vi.fn(() => {
      throw new Error("channel resolver must not run inside a SQLite write");
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "broken",
          source: "test",
          plugin: {
            id: "broken",
            meta: { label: "Broken" },
            messaging: { resolveSessionConversation },
          },
        },
      ]),
    );

    try {
      for (const channel of ["telegram", "discord"]) {
        const sessionKey = `agent:main:${channel}:direct:user`;
        const entry = { sessionId: `${channel}-session`, updatedAt: Date.now() };
        await expect(seedEntry(scopeFor(sessionKey), entry, false)).resolves.toMatchObject(entry);
        expect(loadSessionEntry(scopeFor(sessionKey))).toMatchObject(entry);
      }

      expect(loadSessionEntry(scopeFor(storedKey))).toMatchObject(storedEntry);
      expect(resolveSessionConversation).not.toHaveBeenCalled();
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });

  it("persists automatic dashboard archiving before stale-entry pruning", async () => {
    setMaintenance({
      mode: "enforce",
      archiveDashboardAfter: "7d",
      pruneAfter: "30d",
      maxEntries: 500,
      maxDiskBytes: false,
    });
    const dashboardKey = "agent:main:dashboard:stale-visible-session";
    const dashboardSessionId = "stale-visible-session";
    const oldUpdatedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const transcriptEvent = {
      id: "stale-visible-event",
      timestamp: new Date(oldUpdatedAt).toISOString(),
      type: "metadata",
    };

    await seedEntry(scopeFor(dashboardKey), {
      sessionId: dashboardSessionId,
      updatedAt: oldUpdatedAt,
    });
    await appendTranscriptEvent(
      { ...scopeFor(dashboardKey), sessionId: dashboardSessionId },
      transcriptEvent,
    );

    const maintained = observeSessionMaintenanceChanges(paths.sqlitePath, dashboardKey);
    await seedEntry(
      scopeFor("agent:main:explicit:maintenance-trigger"),
      { sessionId: "maintenance-trigger", updatedAt: Date.now() },
      false,
    );

    await maintained;
    expect(loadSessionEntry(scopeFor(dashboardKey))?.archivedAt).toEqual(expect.any(Number));
    await expect(
      loadTranscriptEvents({ ...storeScope(), sessionId: dashboardSessionId }),
    ).resolves.toEqual([transcriptEvent]);
  });

  it("preserves recent SQLite entries and transcripts during write-triggered capping", async () => {
    setMaintenance({ mode: "enforce", pruneAfter: "365d", maxEntries: 2, preserveRecent: "7d" });
    const now = Date.now();
    const recentSessionId = "recent-dashboard-session-1";
    const recentTranscriptEvent = {
      id: "recent-dashboard-event",
      timestamp: new Date().toISOString(),
      type: "metadata",
    };

    await seedEntry(scopeFor("agent:main:archived-1"), {
      archivedAt: now - 4,
      sessionId: "archived-session-1",
      updatedAt: now - 4,
    });
    await seedEntry(scopeFor("agent:main:recent-dashboard-1"), {
      sessionId: recentSessionId,
      updatedAt: now - 2,
    });
    await appendTranscriptEvent(
      { ...scopeFor("agent:main:recent-dashboard-1"), sessionId: recentSessionId },
      recentTranscriptEvent,
    );
    await seedEntry(scopeFor("agent:main:recent-dashboard-2"), {
      sessionId: "recent-dashboard-session-2",
      updatedAt: now - 1,
    });

    await seedEntry(
      scopeFor("agent:main:maintenance-trigger"),
      { sessionId: "maintenance-trigger-session", updatedAt: now },
      false,
    );

    expect(listSessionEntryRows(storeScope()).map((summary) => summary.sessionKey)).toEqual([
      "agent:main:archived-1",
      "agent:main:maintenance-trigger",
      "agent:main:recent-dashboard-1",
      "agent:main:recent-dashboard-2",
    ]);
    await expect(
      loadTranscriptEvents({ ...storeScope(), sessionId: recentSessionId }),
    ).resolves.toEqual([recentTranscriptEvent]);
  });

  it("preserves pinned SQLite entries and transcripts during write-triggered capping", async () => {
    setMaintenance({ mode: "enforce", pruneAfter: "365d", maxEntries: 2 });
    const now = Date.now();
    const pinnedKey = "agent:main:pinned-dashboard";
    const pinnedSessionId = "pinned-dashboard-session";
    const pinnedTranscriptEvent = {
      id: "pinned-event",
      timestamp: new Date().toISOString(),
      type: "metadata",
    };

    await seedEntry(scopeFor(pinnedKey), { sessionId: pinnedSessionId, updatedAt: 1, pinnedAt: 2 });
    await appendTranscriptEvent(
      { ...scopeFor(pinnedKey), sessionId: pinnedSessionId },
      pinnedTranscriptEvent,
    );
    await seedEntry(scopeFor("agent:main:recent-dashboard"), {
      sessionId: "recent-dashboard-session",
      updatedAt: now - 1,
    });

    const maintained = observeSessionMaintenanceChanges(
      paths.sqlitePath,
      "agent:main:recent-dashboard",
    );
    await seedEntry(
      scopeFor("agent:main:maintenance-trigger"),
      { sessionId: "maintenance-trigger-session", updatedAt: now },
      false,
    );

    await maintained;
    expect(loadSessionEntry(scopeFor(pinnedKey))).toMatchObject({
      pinnedAt: 2,
      sessionId: pinnedSessionId,
    });
    expect(
      listSessionEntryRows(storeScope())
        .filter((summary) => summary.entry.archivedAt === undefined)
        .map((summary) => summary.sessionKey),
    ).toEqual(["agent:main:maintenance-trigger", pinnedKey]);
    expect(listSessionEntryRows(storeScope())).toHaveLength(3);
    expect(loadSessionEntry(scopeFor("agent:main:recent-dashboard"))).toMatchObject({
      sessionId: "recent-dashboard-session",
      archivedAt: expect.any(Number),
      archiveReason: "active-session-cap",
    });
    await expect(
      loadTranscriptEvents({ ...storeScope(), sessionId: pinnedSessionId }),
    ).resolves.toEqual([pinnedTranscriptEvent]);
  });

  it("preserves an admitted SQLite session when another session triggers maintenance", async () => {
    setMaintenance({ mode: "enforce", pruneAfter: "365d", maxEntries: 1 });
    const admittedScope = (sessionKey: string) => scopeFor(sessionKey, paths.storePath);
    const dashboardKey = "agent:main:dashboard:active-work";
    const dashboardEntry = {
      lifecycleRevision: "dashboard-revision-1",
      sessionId: "dashboard-session",
      updatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    };
    for (const [sessionKey, sessionId] of [
      ["agent:main:slack:channel:c1", "channel-session-1"],
      ["agent:main:slack:channel:c2", "channel-session-2"],
    ] as const) {
      await seedEntry(admittedScope(sessionKey), { sessionId, updatedAt: Date.now() - 1 });
    }

    await seedEntry(admittedScope(dashboardKey), dashboardEntry);
    const admission = await beginSessionEffect({
      scope: paths.storePath,
      identities: [dashboardKey, dashboardEntry.sessionId],
      assertAllowed: () => {},
    });
    try {
      const triggerKey = "agent:main:maintenance-trigger";
      await seedEntry(
        admittedScope(triggerKey),
        { sessionId: "trigger-session", updatedAt: Date.now() + 1 },
        false,
      );

      const preservedEntry = loadSessionEntry(admittedScope(dashboardKey));
      expect(preservedEntry).toMatchObject(dashboardEntry);
      expect(preservedEntry?.archivedAt).toBeUndefined();
    } finally {
      admission.release();
    }
  });

  it("keeps live entries and transcripts under byte pressure at save time", async () => {
    setMaintenance({
      highWaterBytes: 350,
      maxDiskBytes: 1_200,
      maxEntries: 100,
      mode: "enforce",
      pruneAfter: "365d",
    });
    const oldUpdatedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const unsharedUpdatedAt = oldUpdatedAt - 1_000;

    await seedEntry(scopeFor("agent:main:unshared-budget"), {
      sessionId: "unshared-budget-session",
      updatedAt: unsharedUpdatedAt,
    });
    await appendTranscriptEvent(
      { ...scopeFor("agent:main:unshared-budget"), sessionId: "unshared-budget-session" },
      {
        id: "unshared-budget-event",
        payload: "😀".repeat(400),
        timestamp: new Date(unsharedUpdatedAt).toISOString(),
        type: "metadata",
      },
    );

    await seedEntry(scopeFor("agent:main:old-budget"), {
      sessionId: "old-budget-session",
      updatedAt: oldUpdatedAt,
    });
    await appendTranscriptEvent(
      { ...scopeFor("agent:main:old-budget"), sessionId: "old-budget-session" },
      {
        id: "old-budget-event",
        payload: "x".repeat(50),
        timestamp: new Date(oldUpdatedAt).toISOString(),
        type: "metadata",
      },
    );
    await seedEntry(scopeFor("agent:main:active-budget"), {
      sessionId: "active-budget-session",
      updatedAt: Date.now(),
      usageFamilySessionIds: ["old-budget-session", "active-budget-session"],
    });

    await patchSessionEntryCore(scopeFor("agent:main:active-budget"), () => ({
      modelOverride: "gpt-5.5",
    }));

    // Live sessions are never save-time budget victims: byte pressure is
    // handled by the async physical-budget pass, which only reclaims
    // historical generations no entry, route, or admission references.
    expect(
      listSessionEntryRows(storeScope())
        .map((summary) => summary.sessionKey)
        .toSorted(),
    ).toEqual(["agent:main:active-budget", "agent:main:old-budget", "agent:main:unshared-budget"]);
    await expect(
      loadTranscriptEvents({ ...storeScope(), sessionId: "old-budget-session" }),
    ).resolves.toEqual([expect.objectContaining({ id: "old-budget-event" })]);
    await expect(
      loadTranscriptEvents({ ...storeScope(), sessionId: "unshared-budget-session" }),
    ).resolves.toEqual([expect.objectContaining({ id: "unshared-budget-event" })]);
    expect(
      fs.readdirSync(paths.tempDir).filter((file) => file.includes(".jsonl.deleted.")),
    ).toEqual([]);
  });

  it("fails loud for delivery-confirmed lowercased SQLite session aliases", async () => {
    const canonicalKey = "agent:main:matrix:channel:!MixedCase:example.org";
    const legacyKey = canonicalKey.toLowerCase();
    const canonicalError = `non-canonical persisted row resolves to session key ${canonicalKey}`;
    const entry = {
      delivery: normalizeSessionDeliveryState({
        context: { accountId: "acct-1", channel: "matrix", to: "!MixedCase:example.org" },
      }),
      sessionId: "legacy-alias-session",
      updatedAt: 10,
    };
    const database = databaseFor();
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(legacyKey, entry.sessionId, JSON.stringify(entry), entry.updatedAt);
    // The entry identity is valid; admission must still reject its delivery-key alias.
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(legacyKey);

    expect(() => loadSessionEntry(scopeFor(canonicalKey))).toThrow(canonicalError);
    expect(() => listSessionEntryRows(storeScope())).toThrow(canonicalError);
    await expect(
      appendTranscriptEvent(
        { ...scopeFor(canonicalKey), sessionId: "canonical-transcript-session" },
        { id: "canonical-event", timestamp: new Date(20).toISOString(), type: "metadata" },
      ),
    ).rejects.toThrow("openclaw doctor --fix");
    expect(() =>
      replaceSessionEntrySync(scopeFor(canonicalKey), { sessionId: "replacement", updatedAt: 20 }),
    ).toThrow("openclaw doctor --fix");
    expect(
      database.db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(legacyKey),
    ).toEqual({ current_session_id: "legacy-alias-session" });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = -1 WHERE session_key = ?")
      .run("{ malformed", legacyKey);
    await expect(
      appendTranscriptEvent(
        { ...scopeFor(canonicalKey), sessionId: "canonical-transcript-session-2" },
        { id: "canonical-event-2", timestamp: new Date(21).toISOString(), type: "metadata" },
      ),
    ).rejects.toThrow("openclaw doctor --fix");
  });

  it("fails loud for invalid imported rows instead of treating them as retained tombstones", () => {
    const sessionKey = "agent:main:invalid-live-row";
    const sessionId = "invalid-live-session";
    const database = databaseFor();
    markCanonicalSessionValidationPending(database, [sessionKey]);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, -1, ?)",
      )
      .run(sessionKey, sessionId, "{ malformed", 10);
    database.db
      .prepare(
        "INSERT INTO session_windows (session_id, session_key, session_scope, reason, created_at, updated_at) VALUES (?, ?, 'conversation', 'initial', 10, 10)",
      )
      .run(sessionId, sessionKey);

    expect(() => listSessionEntryRows(storeScope())).toThrow("openclaw doctor --fix");
  });

  it("fails loud when imported lineage disagrees with canonical entry JSON", async () => {
    const sessionKey = "agent:main:lineage-mismatch";
    const sessionId = "lineage-mismatch-session";
    const entry = { parentSessionKey: "agent:main:json-parent", sessionId, updatedAt: 10 };
    const database = databaseFor();
    markCanonicalSessionValidationPending(database, [sessionKey]);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionKey, sessionId, JSON.stringify(entry), 10, "agent:main:column-parent");
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sessionKey);

    await expect(
      listSessionChildEntriesReadOnly(scopeFor("agent:main:json-parent")),
    ).rejects.toThrow("openclaw doctor --fix");
    expect(() => listSessionEntryRows(storeScope())).toThrow("openclaw doctor --fix");
  });

  it("normalizes missing entry updatedAt before writing root and entry rows", async () => {
    await replaceSessionEntry(scopeFor("agent:main:minimal"), {
      sessionId: "minimal-session",
      sessionStartedAt: 123,
    } as SessionEntry);

    const loaded = loadSessionEntry(scopeFor("agent:main:minimal"));
    expect(loaded).toMatchObject({
      sessionId: "minimal-session",
      sessionStartedAt: 123,
      updatedAt: 123,
    });

    const database = databaseFor();
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_windows as sw")
        .innerJoin("session_nodes as sn", "sn.current_session_id", "sw.session_id")
        .select([
          "sw.created_at as window_created_at",
          "sw.updated_at as window_updated_at",
          "sn.entry_json",
          "sn.updated_at as node_updated_at",
        ])
        .where("sw.session_id", "=", "minimal-session"),
    );
    expect(row).toEqual({
      entry_json: JSON.stringify({
        sessionId: "minimal-session",
        sessionStartedAt: 123,
        delivery: { kind: "none" },
        updatedAt: 123,
      }),
      node_updated_at: 123,
      window_created_at: 123,
      window_updated_at: 123,
    });

    await upsertSessionEntryCore(scopeFor("agent:main:minimal-upsert"), {
      sessionId: "minimal-upsert-session",
    });
    const upsertRow = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select(["entry_json", "updated_at"])
        .where("session_key", "=", "agent:main:minimal-upsert"),
    );
    const upsertEntry = JSON.parse(upsertRow?.entry_json ?? "{}") as Partial<SessionEntry>;
    expect(upsertEntry).toMatchObject({
      sessionId: "minimal-upsert-session",
      updatedAt: expect.any(Number),
    });
    expect(upsertRow?.updated_at).toBe(upsertEntry.updatedAt);
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

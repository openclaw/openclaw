import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { encodeSessionArchiveContent } from "../config/sessions/archive-compression.js";
import {
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { prepareSessionEntryPresenceRead } from "../config/sessions/session-entry-presence-read.js";
import { readSessionHistoryPageInWorker } from "../config/sessions/session-history-worker-runtime.js";
import {
  historyClearTimeout,
  historyLane,
  maintenanceLane,
  rotateDatabaseWorkers,
  targetDiscoveryLane,
} from "../config/sessions/session-transcript-worker-resources.js";
import {
  prewarmSessionHistoryWorker,
  withSessionHistoryWorkerDatabase,
} from "../config/sessions/session-transcript-worker-runtime.js";
import { getSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { DEFAULT_WORKER_PENDING_BYTES } from "../infra/worker-task-capacity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  captureOpenClawAgentDatabaseRegistration,
  invalidateRegisteredAgentDatabasesMemo,
} from "../state/openclaw-agent-db-registry-listing.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import { createArchivedSessionTranscriptSource } from "./session-end-transcript-reader.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";

const observed = vi.hoisted(() => ({
  timers: vi.spyOn(globalThis, "setTimeout"),
  workers: [] as Worker[],
  idleCloseKeepsWorker: new WeakMap<Worker, boolean>(),
  dispatch: undefined as ((message: unknown) => void) | undefined,
  restoration: undefined as
    | {
        sessionId: string;
        phase: "before restoration" | "queued restoration";
        entered: () => void;
        wait: Promise<void>;
      }
    | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        const { explicitSqliteCloseReleasesNativeResources } = getSqliteRuntimeCapabilities();
        super(...args);
        // Match the decision this generation inherits, before any later admission.
        observed.idleCloseKeepsWorker.set(this, explicitSqliteCloseReleasesNativeResources);
      }

      override postMessage(...args: Parameters<Worker["postMessage"]>): void {
        const kind = asOptionalRecord(asOptionalRecord(args[0])?.input)?.kind;
        if (
          (kind === "prewarm" || kind === "history-page" || kind === "session-row-presence") &&
          !observed.workers.includes(this)
        ) {
          observed.workers.push(this);
        }
        observed.dispatch?.(args[0]);
        super.postMessage(...args);
      }
    },
  };
});
vi.mock("../config/sessions/session-cold-storage-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-cold-storage-read.js")>();
  return {
    ...actual,
    readRestoredSessionTranscript: async (
      ...args: Parameters<typeof actual.readRestoredSessionTranscript>
    ) => {
      const held = observed.restoration;
      if (!held || args[0].sessionId !== held.sessionId) {
        return actual.readRestoredSessionTranscript(...args);
      }
      if (held.phase === "before restoration") {
        held.entered();
        await held.wait;
        return actual.readRestoredSessionTranscript(...args);
      }
      const [scope, read, options] = args;
      const coldRead = options?.coldRead;
      if (!coldRead) {
        throw new Error("Queued restoration fixture requires prepared cold metadata");
      }
      return actual.readRestoredSessionTranscript(scope, read, {
        ...options,
        coldRead: {
          ...coldRead,
          readMetadata: async (phase) => {
            if (phase === "queued") {
              held.entered();
              await held.wait;
            }
            return coldRead.readMetadata(phase);
          },
        },
      });
    },
  };
});

afterAll(() => observed.timers.mockRestore());

afterEach(async () => {
  observed.dispatch = undefined;
  observed.restoration = undefined;
  await Promise.all(
    [historyLane, maintenanceLane, targetDiscoveryLane].map(async (lane) => {
      historyClearTimeout(lane.idleTimer);
      await rotateDatabaseWorkers(lane);
    }),
  );
  for (const worker of observed.workers.splice(0)) {
    expect(worker.threadId).toBe(-1);
  }
});

it.each([false, true])(
  "reads exact row presence from its captured target without creating a database (incognito=%s)",
  async (incognito) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-presence"
          : "agent:main:dashboard:presence",
        storePath: path.join(state.agentDir(), "presence.sqlite"),
        env: { ...state.env },
      };
      const databasePath = incognito
        ? resolveIncognitoOpenClawAgentSqlitePath(target)
        : target.storePath;
      const { read } = prepareSessionEntryPresenceRead(target);
      const workersBefore = observed.workers.length;
      expect(await read()).toBe(false);
      expect(fs.existsSync(databasePath)).toBe(false);
      await replaceSessionEntry(target, { sessionId: "metadata-without-transcript", updatedAt: 1 });
      expect(await read()).toBe(true);
      expect(
        await prepareSessionEntryPresenceRead({
          ...target,
          sessionKey: target.sessionKey.toUpperCase(),
        }).read(),
      ).toBe(true);
      expect(
        await prepareSessionEntryPresenceRead({
          ...target,
          sessionKey: `${target.sessionKey}-sibling`,
        }).read(),
      ).toBe(false);
      if (incognito) {
        expect(observed.workers).toHaveLength(workersBefore);
        expect(fs.existsSync(databasePath)).toBe(false);
      } else {
        expect(observed.workers.length).toBeGreaterThan(workersBefore);
        target.storePath = path.join(state.agentDir(), "replacement.sqlite");
        target.env.OPENCLAW_STATE_DIR = state.path("different-state");
        expect(await read()).toBe(true);
        expect(await prepareSessionEntryPresenceRead(target).read()).toBe(false);
        expect(fs.existsSync(target.storePath)).toBe(false);
      }
    });
  },
);

it("reads an exact ended-session archive in the history worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionId = "deleted-session-archive";
    const fixture = await seed(state, "main", sessionId);
    const content = [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "archived-message",
        parentId: null,
        message: { role: "user", content: "archived content" },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const encoded = encodeSessionArchiveContent(`${content}\n`);
    const archivePath = state.path(
      `deleted.jsonl.deleted.2026-09-29T00-00-00.000Z${encoded.suffix}`,
    );
    fs.writeFileSync(archivePath, encoded.bytes);
    const source = createArchivedSessionTranscriptSource({
      agentId: "main",
      archivedPath: archivePath,
      sessionId,
      storePath: fixture.target.storePath,
    });
    if (!source.available) {
      throw new Error("expected an available archive source");
    }
    const workersBefore = observed.workers.length;

    await expect(source.readTail({ maxBytes: 64 * 1_024, maxMessages: 10 })).resolves.toMatchObject(
      {
        messages: [expect.objectContaining({ role: "user", content: "archived content" })],
        totalMessages: 1,
      },
    );

    expect(observed.workers.length).toBeGreaterThan(workersBefore);
    expect(observed.workers.at(-1)?.threadId).toBeGreaterThan(0);
  });
});

it("keeps fresh fixture roots isolated while reusing idle reader execution", async () => {
  let previousWorker: Worker | undefined;
  for (const sessionId of ["first-fixture", "second-fixture"]) {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await seed(state, "main", sessionId);
      await prewarmSessionHistoryWorker({ agentId: "main", path: fixture.path, env: state.env });
      const prewarmedWorker = observed.workers.at(-1);
      expect((await fixture.read()).messages.map(readChatHistoryMessageId)).toEqual([
        `${sessionId}-message`,
      ]);
      const worker = observed.workers.at(-1)!;
      expect(worker).toBe(prewarmedWorker);
      if (previousWorker) {
        if (observed.idleCloseKeepsWorker.get(previousWorker) !== true) {
          expect(previousWorker.threadId).toBe(-1);
          expect(worker).not.toBe(previousWorker);
        } else {
          expect(worker).toBe(previousWorker);
        }
      }
      previousWorker = worker;
    });
  }
  await closeOpenClawStateDatabaseAsync();
  expect(previousWorker?.threadId).toBe(-1);
});

async function seed(state: OpenClawTestState, agentId: string, sessionId: string) {
  const target = {
    agentId,
    sessionId,
    sessionKey: `agent:${agentId}:${sessionId}`,
    storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
  };
  const entry = { sessionId, updatedAt: 1 };
  // Seed reader lifecycle fixtures without queueing unrelated automatic maintenance.
  await patchSessionEntryCore(target, () => entry, {
    fallbackEntry: entry,
    replaceEntry: true,
    skipMaintenance: true,
  });
  await replaceTranscriptEvents(target, [
    { type: "session", version: 3, id: sessionId },
    {
      type: "message",
      id: `${sessionId}-message`,
      parentId: null,
      message: { role: "user", content: sessionId },
    },
  ]);
  await waitForSessionTranscriptProjection(target);
  const params = {
    entry,
    provider: undefined,
    sessionId,
    storePath: target.storePath,
    sessionAgentId: agentId,
    canonicalKey: target.sessionKey,
    max: 20,
    maxHistoryBytes: 100_000,
    effectiveMaxChars: 8000,
    offset: undefined,
    messageId: undefined,
  };
  return {
    target,
    path: resolveOpenClawAgentSqlitePath({ agentId, env: state.env }),
    read: () => readChatHistoryPage(params),
  };
}

it("settles cancelled message reads before reuse and closes their database handles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await seed(state, "main", "cancel-message-read");
    await closeOpenClawAgentDatabaseByPathAsync(fixture.path, "main");
    const controller = new AbortController();
    const cancelled = new Error("history consumer closed");
    let dispatched = false;
    observed.dispatch = (message) => {
      const input = asOptionalRecord(asOptionalRecord(message)?.input);
      if (asOptionalRecord(input?.request)?.kind === "message-by-id") {
        observed.dispatch = undefined;
        dispatched = true;
        controller.abort(cancelled);
      }
    };
    const pending = readSessionHistoryPageInWorker(
      {
        kind: "message-by-id",
        params: { target: fixture.target, messageId: "cancel-message-read-message" },
      },
      controller.signal,
    );
    await expect(pending).rejects.toBe(cancelled);
    expect(dispatched).toBe(true);
    const worker = observed.workers.at(-1)!;
    const threadId = worker.threadId;
    expect((await fixture.read()).messages.map(readChatHistoryMessageId)).toEqual([
      "cancel-message-read-message",
    ]);
    expect(observed.workers.at(-1)).toBe(worker);
    const keepsWorker = observed.idleCloseKeepsWorker.get(worker) === true;
    await closeOpenClawAgentDatabaseByPathAsync(fixture.path, "main");
    expect(worker.threadId).toBe(keepsWorker ? threadId : -1);
    expect((await fixture.read()).messages.map(readChatHistoryMessageId)).toEqual([
      "cancel-message-read-message",
    ]);
    if (!keepsWorker) {
      expect(observed.workers.at(-1)).not.toBe(worker);
    } else {
      expect(observed.workers.at(-1)).toBe(worker);
    }
  });
});

it.each(["no-commit", "metadata-refresh"] as const)(
  "reads history after unchanged sibling registration (%s)",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const a = await seed(state, "main", "registration-a");
      const b = await seed(state, "other", "registration-b");
      await a.read();
      await b.read();
      const registryPath = openOpenClawStateDatabase().path;
      const registration = captureOpenClawAgentDatabaseRegistration({
        agentId: "other",
        agentPath: b.path,
        admission: captureOpenClawStateDatabaseReadAdmission(registryPath),
      });
      invalidateRegisteredAgentDatabasesMemo({ path: registryPath });
      registration.begin();
      try {
        if (mode === "metadata-refresh") {
          registerOpenClawAgentDatabase(
            { agentId: "other", path: b.path, env: state.env },
            { committed: (receipt) => registration.recordCommitted(receipt) },
          );
        }
      } finally {
        registration.finish();
      }
      expect((await a.read()).messages.map(readChatHistoryMessageId)).toEqual([
        "registration-a-message",
      ]);
    });
  },
);

it("closes idle A while active and queued B pages survive, then reads replaced A", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const a = await seed(state, "main", "close-a");
    const b = await seed(state, "other", "active-b");
    const c = await seed(state, "other", "queued-b");
    expect((await a.read()).messages.map(readChatHistoryMessageId)).toEqual(["close-a-message"]);
    await b.read();
    const oldWorker = observed.workers.at(-1)!;
    const threadId = oldWorker.threadId;
    const keepsWorker = observed.idleCloseKeepsWorker.get(oldWorker) === true;
    let closing: Promise<boolean> | undefined;
    observed.dispatch = (message) => {
      const input = asOptionalRecord(asOptionalRecord(message)?.input);
      const params = asOptionalRecord(asOptionalRecord(input?.request)?.params);
      if (params?.sessionId === "active-b") {
        observed.dispatch = undefined;
        closing = closeOpenClawAgentDatabaseByPathAsync(a.path, "main");
      }
    };
    const results = await Promise.all([b.read(), c.read()]);
    expect(closing).toBeDefined();
    await closing;
    expect(results.map((page) => page.messages.map(readChatHistoryMessageId))).toEqual([
      ["active-b-message"],
      ["queued-b-message"],
    ]);
    expect(oldWorker.threadId).toBe(keepsWorker ? threadId : -1);
    // This also exercises Windows replacement while the unrelated agent remains usable.
    fs.copyFileSync(a.path, `${a.path}.replacement`);
    fs.renameSync(a.path, `${a.path}.previous`);
    fs.renameSync(`${a.path}.replacement`, a.path);
    await replaceTranscriptEvents(a.target, [
      { type: "session", version: 3, id: "close-a" },
      {
        type: "message",
        id: "replacement-a-message",
        parentId: null,
        message: { role: "user", content: "replacement content" },
      },
    ]);
    await waitForSessionTranscriptProjection(a.target);
    expect((await a.read()).messages.map(readChatHistoryMessageId)).toEqual([
      "replacement-a-message",
    ]);
    expect((await b.read()).messages.map(readChatHistoryMessageId)).toEqual(["active-b-message"]);
  });
});

it("evicts the least recently used of 64 retained targets without charging missing databases", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const targets = [];
    for (let index = 0; index < 65; index++) {
      targets.push(await seed(state, `retained-${index}`, `history-${index}`));
    }
    for (const target of targets.slice(0, 64)) {
      await target.read();
    }
    await targets[0]!.read();
    const worker = observed.workers.at(-1)!;
    const threadId = worker.threadId;
    for (let index = 0; index < 65; index++) {
      const target = {
        agentId: `missing-${index}`,
        sessionKey: `agent:missing-${index}:absent`,
        storePath: state.statePath(`missing-${index}.sqlite`),
        env: state.env,
      };
      expect(await prepareSessionEntryPresenceRead(target).read()).toBe(false);
      expect(fs.existsSync(target.storePath)).toBe(false);
    }
    await targets[64]!.read();
    const keepsWorker = observed.idleCloseKeepsWorker.get(worker) === true;
    const closeResources = vi.spyOn(historyLane.pool, "closeResources");
    try {
      // The evicted target has no retained native custody; the hot target still does.
      await closeOpenClawAgentDatabaseByPathAsync(targets[1]!.path, "retained-1");
      expect(worker.threadId).toBe(threadId);
      expect(closeResources).not.toHaveBeenCalled();
      await closeOpenClawAgentDatabaseByPathAsync(targets[0]!.path, "retained-0");
      expect(worker.threadId).toBe(keepsWorker ? threadId : -1);
      if (keepsWorker) {
        expect(closeResources).toHaveBeenCalledWith(JSON.stringify([{ path: targets[0]!.path }]));
      }
    } finally {
      closeResources.mockRestore();
    }
    expect((await targets[64]!.read()).messages.map(readChatHistoryMessageId)).toEqual([
      "history-64-message",
    ]);
  });
});

it.for(["before restoration", "queued restoration"] as const)(
  "does not restore a replacement database for a revoked history read (%s)",
  async (phase, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      const fixture = await createSessionColdStorageFixture(databasePath);
      const unrelated =
        phase === "before restoration" ? await seed(state, "other", "unrelated-b") : undefined;
      await unrelated?.read();
      expect(
        await runSessionColdStorageMaintenance({ config: maintenanceConfig(databasePath) }),
      ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
      const readStoredTranscript = () =>
        withOpenClawAgentDatabaseReadOnly(
          ({ db }) => ({
            cold: readSessionColdTranscript(db, fixture.scope.sessionId),
            events: db
              .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
              .all(fixture.scope.sessionId),
          }),
          fixture.options,
        );
      const before = readStoredTranscript();
      expect(before).toEqual({
        found: true,
        value: {
          cold: expect.objectContaining({ session_id: fixture.scope.sessionId }),
          events: [],
        },
      });
      const entered = createDeferredCore();
      const gate = createDeferredCore();
      observed.restoration = {
        sessionId: fixture.scope.sessionId,
        phase,
        entered: entered.resolve,
        wait: gate.promise,
      };
      const read = () =>
        readChatHistoryPage({
          entry: undefined,
          provider: undefined,
          sessionId: fixture.scope.sessionId,
          storePath: databasePath,
          sessionAgentId: fixture.scope.agentId,
          canonicalKey: fixture.scope.sessionKey,
          max: 20,
          maxHistoryBytes: 100_000,
          effectiveMaxChars: 8000,
          offset: undefined,
          messageId: undefined,
        });
      const pending = read();
      const failure = expect(pending).rejects.toThrow("revoked");
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "History read settled before reaching the restoration boundary",
          ),
          signal,
        );
        await closeOpenClawAgentDatabaseByPathAsync(databasePath, "main");
        if (unrelated) {
          expect((await unrelated.read()).messages.map(readChatHistoryMessageId)).toEqual([
            "unrelated-b-message",
          ]);
        }
        fs.copyFileSync(databasePath, `${databasePath}.replacement`);
        fs.renameSync(databasePath, `${databasePath}.previous`);
        fs.renameSync(`${databasePath}.replacement`, databasePath);
        expect(readStoredTranscript()).toEqual(before);
      } finally {
        observed.restoration = undefined;
        gate.resolve();
        await failure;
      }
      expect(readStoredTranscript()).toEqual(before);
      if (unrelated) {
        expect((await read()).messages.map(readChatHistoryMessageId)).toEqual([
          "history-user",
          "history-assistant",
        ]);
      }
    });
  },
);

it("leaves the unrelated warm worker running when admission rejects a request before dispatch", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const b = await seed(state, "other", "overload-b");
    await b.read();
    const worker = observed.workers.at(-1)!;
    const threadId = worker.threadId;
    await expect(
      withSessionHistoryWorkerDatabase(
        {
          agentId: "main",
          path: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        },
        (owner) =>
          owner.run(() => {
            throw new Error("refused factory must not run");
          }, DEFAULT_WORKER_PENDING_BYTES + 1),
      ),
    ).rejects.toMatchObject({ code: "overloaded" });
    expect(worker.threadId).toBe(threadId);
    expect((await b.read()).messages.map(readChatHistoryMessageId)).toEqual(["overload-b-message"]);
    expect(observed.workers.at(-1)).toBe(worker);
  });
});

it.each([false, true])(
  "joins the history worker when its 30-minute idle timer fires (missing=%s)",
  async (missing) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const a = missing
        ? prepareSessionEntryPresenceRead({
            agentId: "main",
            sessionKey: "agent:main:idle-missing",
            storePath: state.statePath("idle-missing.sqlite"),
            env: state.env,
          })
        : await seed(state, "main", "idle-a");
      const beforeRead = observed.timers.mock.calls.length;
      await a.read();
      const worker = observed.workers.at(-1)!;
      const index = observed.timers.mock.calls.findLastIndex((call) => call[1] === 30 * 60_000);
      expect(index).toBeGreaterThanOrEqual(beforeRead);
      const [expire] = observed.timers.mock.calls[index]!;
      const timer = observed.timers.mock.results[index]!.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      clearTimeout(timer);
      expire();
      await expect.poll(() => worker.threadId).toBe(-1);
      const reopened = await a.read();
      if (typeof reopened === "boolean") {
        expect(reopened).toBe(false);
      } else {
        expect(reopened.messages.map(readChatHistoryMessageId)).toEqual(["idle-a-message"]);
      }
      expect(observed.workers.at(-1)).not.toBe(worker);
      if (missing) {
        // No database resource exists to close; the reopened empty worker owns only its idle timer.
        const emptyWorker = observed.workers.at(-1)!;
        const nextIndex = observed.timers.mock.calls.findLastIndex(
          (call) => call[1] === 30 * 60_000,
        );
        expect(nextIndex).toBeGreaterThan(index);
        clearTimeout(observed.timers.mock.results[nextIndex]!.value as NodeJS.Timeout);
        observed.timers.mock.calls[nextIndex]![0]();
        await expect.poll(() => emptyWorker.threadId).toBe(-1);
        expect(observed.timers.mock.calls.filter((call) => call[1] === 30 * 60_000)).toHaveLength(
          observed.timers.mock.calls
            .slice(0, nextIndex + 1)
            .filter((call) => call[1] === 30 * 60_000).length,
        );
      }
    });
  },
);

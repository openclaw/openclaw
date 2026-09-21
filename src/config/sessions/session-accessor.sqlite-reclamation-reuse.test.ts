import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  conversation,
  queueConversationDeliveryForTest,
} from "../../gateway/conversation-delivery.test-support.js";
import { runGatewayConversationList } from "../../gateway/conversation-list.js";
import { runGatewayConversationSend } from "../../gateway/conversation-send.js";
import { completeDurableDelivery } from "../../infra/outbound/delivery-completion.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import * as messageActionRunner from "../../infra/outbound/message-action-runner.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "../../state/openclaw-agent-db-lease.js";
import {
  getOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidationForTransfer,
  invalidateOpenClawAgentDatabaseValidation,
  setOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import { withOpenClawAgentDatabaseWrite } from "../../state/openclaw-agent-db-write.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import { createAgentDatabaseNativeGeneration } from "../../state/openclaw-agent-execution-native.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { clearOpenClawAgentIntegrityVerification } from "../../state/openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  beginConversationDeliveryOperation,
  getConversationDeliveryOperation,
  markConversationDeliveryQueued,
} from "./conversation-delivery-store.js";
import { listConversations, registerConversationAddresses } from "./conversation-registry.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import { loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { withWorkerSqliteIntegrityCounter } from "./session-accessor.sqlite-integrity-counter.test-support.js";
import * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import {
  createLifecycleArtifactReclamationPlan,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

const validation = vi.hoisted(() => ({
  checks: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        super(
          filename,
          options.workerData?.operation === "reclaim"
            ? withWorkerSqliteIntegrityCounter(options, validation.checks)
            : options,
        );
      }
    },
  };
});

beforeEach(() => {
  validation.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
});
function fullChecks() {
  return Atomics.load(new Int32Array(validation.checks), 0);
}

const tempDirs = createTempDirTracker();
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  vi.unstubAllEnvs();
});

function createFixture(sessionIds = ["first", "second"], agentId = "main") {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("reclamation-reuse-")) };
  const options = { agentId, env };
  const scopes = sessionIds.map((sessionId) => ({
    agentId: options.agentId,
    env,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  }));
  for (const scope of scopes) {
    ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  }
  const database = openOpenClawAgentDatabase(options);
  const plans = scopes.map((scope) =>
    createLifecycleArtifactReclamationPlan({
      agentId: "main",
      databaseOptions: { ...options, path: database.path },
      entries: [{ sessionKey: scope.sessionKey, expectedEntry: loadSessionEntryReadOnly(scope) }],
      materializedPlans: [],
    }),
  );
  return { options, scopes, database, plans };
}

function observeReclamationWorkers(onSpawn?: (worker: Worker) => void) {
  const spawned: Worker[] = [];
  const create = archiveWorker.createSqliteTranscriptArchiveWorker;
  vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
    const worker = create(data);
    spawned.push(worker);
    onSpawn?.(worker);
    return worker;
  });
  return spawned;
}

function leasesFor(fixture: ReturnType<typeof createFixture>) {
  return openOpenClawStateDatabase({ env: fixture.options.env })
    .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?")
    .all(fixture.database.path);
}

test.each(["current", "revoked-after-open", "revoked-during-open"] as const)(
  "reclamation borrows native-only verification unless revoked (%s)",
  async (proof) => {
    const { database, options, plans, scopes } = createFixture(["victim"]);
    closeOpenClawAgentDatabasesForTest(options.env.OPENCLAW_STATE_DIR);
    const context = captureOpenClawStateWorkerContext(options);
    const assertCurrent = () => context.admission.assertCurrent();
    let revokedDuringOpen = false;
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent,
      createAdmission(binding) {
        return () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            if (
              proof === "revoked-during-open" &&
              !revokedDuringOpen &&
              request.stage === "prepare" &&
              isRecord(request.facts) &&
              isRecord(request.facts.identity) &&
              request.facts.identity.kind === "file"
            ) {
              invalidateOpenClawAgentDatabaseValidation(database.path);
              revokedDuringOpen = true;
            }
            binding.authorize(request);
            assertCurrent();
            if (!grant()) {
              throw new Error("Native reclamation fixture lost admission");
            }
          }),
        });
      },
    };
    const generation = createAgentDatabaseNativeGeneration(
      database.agentId,
      database.path,
      context,
      assertCurrent,
      assertCurrent,
      undefined,
      () => {},
    );
    try {
      await generation.runExisting(source, async () => "opened");
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      const transferred = getOpenClawAgentDatabaseValidationForTransfer(database);
      expect(Boolean(transferred)).toBe(proof !== "revoked-during-open");
      if (proof === "revoked-after-open") {
        invalidateOpenClawAgentDatabaseValidation(database.path);
      }
      await expect(
        runSqliteSessionReclamation({ forceInProcess: false, plan: plans[0]! }),
      ).resolves.toMatchObject({ kind: "lifecycle-artifacts", value: { removedEntries: 1 } });
      expect(fullChecks()).toBe(proof === "current" ? 0 : 1);
      expect(revokedDuringOpen).toBe(proof === "revoked-during-open");
      expect(loadSessionEntryReadOnly(scopes[0]!)).toBeUndefined();
    } finally {
      await generation.close();
    }
  },
);

test.each(["directory discovery", "Gateway send", "durable completion"] as const)(
  "admits %s behind a native reclamation commit request",
  async (operation) => {
    const fixture = createFixture();
    const { database, options, plans, scopes } = fixture;
    vi.stubEnv("OPENCLAW_STATE_DIR", options.env.OPENCLAW_STATE_DIR);
    const scope = { agentId: "main", storePath: database.path, env: options.env };
    const config = { agents: { entries: { main: {} } }, session: { store: database.path } };
    const operationId = "conversation-admission";
    if (operation !== "directory discovery") {
      registerConversationAddresses(scope, [
        { ...conversation, deliveryTarget: conversation.target },
      ]);
    }
    if (operation === "durable completion") {
      beginConversationDeliveryOperation(scope, {
        operationId,
        operationKind: "send",
        conversationRef: conversation.conversationRef,
        message: "synthetic message",
      });
      markConversationDeliveryQueued(scope, operationId, "queue-admission");
    }
    const runForeground = (): Promise<unknown> => {
      if (operation === "directory discovery") {
        return runGatewayConversationList(
          { config, agentId: "main", channel: "reef", limit: 10 },
          {
            listConversations,
            registerConversationAddresses,
            resolveOutboundChannelPlugin: () => ({
              ...createChannelTestPluginBase({
                id: "reef",
                config: { isEnabled: () => true, isConfigured: () => true },
              }),
              directory: {
                listPeers: async () => [{ kind: "user", id: "molty", name: "Synthetic peer" }],
              },
            }),
            resolveOutboundSessionRoute: async () => ({
              sessionKey: conversation.sessionKey,
              baseSessionKey: conversation.sessionKey,
              peer: { kind: "direct", id: "molty" },
              chatType: "direct",
              from: "reef:molty",
              to: conversation.target,
            }),
          },
        );
      }
      if (operation === "Gateway send") {
        vi.spyOn(messageActionRunner, "runMessageAction").mockImplementation(
          async (input): Promise<MessageActionResult> => {
            await queueConversationDeliveryForTest(input, "queue-admission");
            return {
              kind: "send",
              channel: "reef",
              action: "send",
              to: conversation.target,
              handledBy: "core",
              payload: {},
              dryRun: false,
              sendResult: {
                channel: "reef",
                to: conversation.target,
                via: "direct",
                mediaUrl: null,
                result: { messageId: "outbound-admission" },
                deliveryStatus: "sent",
              },
            };
          },
        );
        return runGatewayConversationSend({
          config,
          agentId: "main",
          senderIsOwner: true,
          operationId,
          conversationRef: conversation.conversationRef,
          message: "synthetic message",
        });
      }
      return completeDurableDelivery(
        { kind: "conversation", ...scope, operationId },
        { channel: "reef", messageId: "outbound-admission" },
        options.env.OPENCLAW_STATE_DIR,
      );
    };
    const order: string[] = [];
    let foreground: Promise<unknown> | undefined;
    let authorization: Promise<void> | undefined;
    let authorizerDelayMs: number | undefined;
    const withWorker = reclamationWorker.withSqliteReclamationWorker;
    vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
      (workerOptions, claim, run, assertCurrent) =>
        withWorker(
          workerOptions,
          claim,
          async (worker) => {
            const execute = worker.run.bind(worker);
            const spy = vi.spyOn(worker, "run").mockImplementation((params) =>
              execute({
                ...params,
                onCommitRequest: () => {
                  const startedAt = performance.now();
                  order.push("commit-request");
                  foreground = Promise.resolve()
                    .then(runForeground)
                    .finally(() => {
                      order.push("foreground-settled");
                    });
                  // Exercise real foreground work before the pending native commit is authorized.
                  authorization = yieldToEventLoop().then(() => {
                    authorizerDelayMs = performance.now() - startedAt;
                    order.push("authorize");
                    params.onCommitRequest();
                  });
                  void foreground.catch(() => undefined);
                  void authorization.catch(() => undefined);
                  return [];
                },
              }),
            );
            try {
              return await run(worker);
            } finally {
              spy.mockRestore();
            }
          },
          assertCurrent,
        ),
    );
    const workers = observeReclamationWorkers();
    try {
      const result = await runSqliteSessionReclamation({ forceInProcess: false, plan: plans[0]! });
      await Promise.all([foreground, authorization]);
      expect(order).toEqual(["commit-request", "authorize", "foreground-settled"]);
      expect(authorizerDelayMs).toBeLessThan(500);
      expect(result).toMatchObject({ kind: "lifecycle-artifacts", value: { removedEntries: 1 } });
      expect(loadSessionEntryReadOnly(scopes[0]!)).toBeUndefined();
      if (operation === "directory discovery") {
        expect(listConversations(scope)).toEqual([
          expect.objectContaining({
            conversationRef: conversation.conversationRef,
            target: conversation.target,
          }),
        ]);
      } else {
        expect(getConversationDeliveryOperation(scope, operationId)).toMatchObject({
          status: "sent",
          platformMessageId: "outbound-admission",
        });
      }
      expect(workers).toHaveLength(1);
    } finally {
      await Promise.allSettled([foreground, authorization]);
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      vi.unstubAllEnvs();
    }
    expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
    expect(leasesFor(fixture)).toHaveLength(0);
  },
);

test("retained reclamation operations share the first full scan until the Gateway owner invalidates it", async () => {
  const { options, database, scopes } = createFixture(["parent", "child"]);
  const databaseOptions = { ...options, path: database.path };
  const plan = reclamation.createHistoryEvictionReclamationPlan({
    databaseOptions,
    diskBudget: {},
    materializedPlans: [],
    protectedSessionIds: new Set(scopes.map((scope) => scope.sessionId)),
    sessionId: "already-removed-history",
  });
  for (const scope of scopes) {
    expect(appendTranscriptEventSync(scope, { type: "integrity-proof-survivor" })).toEqual({
      ok: true,
      value: true,
    });
  }
  closeOpenClawAgentDatabasesForTest(databaseOptions.env.OPENCLAW_STATE_DIR);
  clearOpenClawAgentIntegrityVerification(database.path, databaseOptions.env);
  const workerIds = new Set<number>();
  for (let pass = 0; pass < 3; pass += 1) {
    if (pass === 2) {
      await closeOpenClawAgentDatabasesAsync(databaseOptions.env.OPENCLAW_STATE_DIR);
      closeOpenClawAgentDatabasesForTest(databaseOptions.env.OPENCLAW_STATE_DIR);
      clearOpenClawAgentIntegrityVerification(database.path, databaseOptions.env);
    }
    const diagnostics: SqliteSessionReclamationDiagnostics = {};
    await expect(
      runSqliteSessionReclamation({ forceInProcess: false, plan, diagnostics }),
    ).resolves.toMatchObject({ kind: "history-eviction", value: { deleted: true } });
    expect(fullChecks()).toBe(pass === 2 ? 2 : 1);
    expect(diagnostics.workerThreadId).toBeGreaterThan(0);
    workerIds.add(diagnostics.workerThreadId!);
    for (const scope of scopes) {
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe(scope.sessionId);
      expect(await loadTranscriptEvents(scope)).toContainEqual({
        type: "integrity-proof-survivor",
      });
    }
  }
  expect(workerIds.size).toBe(2);
});

test("warm Worker results cannot revive proof invalidated after a competing parent verification", async () => {
  const { database, plans } = createFixture();
  invalidateOpenClawAgentDatabaseValidation(database.path);
  const observed: {
    worker?: OpenClawAgentDatabaseValidation;
    parent?: OpenClawAgentDatabaseValidation;
  } = {};
  const spawned = observeReclamationWorkers((worker) => {
    worker.prependListener(
      "message",
      (message: reclamationWorker.SqliteReclamationWorkerMessage) => {
        if (message.type === "reclaimed" && message.operationId === 1) {
          observed.worker = message.validation;
          // A concurrent canonical opener can finish before the first Worker result is adopted.
          observed.parent = setOpenClawAgentDatabaseValidation(database);
        }
      },
    );
  });
  await runSqliteSessionReclamation({ forceInProcess: false, plan: plans[0]! });
  expect(observed.worker).toBeDefined();
  expect(observed.parent).toBeDefined();
  expect(getOpenClawAgentDatabaseValidation(database)).toBe(observed.parent);

  invalidateOpenClawAgentDatabaseValidation(database.path);
  expect(Atomics.load(new Int32Array(observed.worker!.valid), 0)).toBe(1);
  expect(Atomics.load(new Int32Array(observed.parent!.valid), 0)).toBe(0);
  await runSqliteSessionReclamation({ forceInProcess: false, plan: plans[1]! });
  expect(spawned).toHaveLength(1);
  expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
});

test.each([
  { cold: false, agentId: "main" },
  { cold: true, agentId: "main" },
  { cold: false, agentId: "MAIN" },
])(
  "keeps each request context and reopens after explicit database retirement (retire: $cold, agent: $agentId)",
  async ({ cold, agentId }) => {
    const fixture = createFixture(undefined, agentId);
    const { options, database, plans, scopes } = fixture;
    invalidateOpenClawAgentDatabaseValidation(database.path);
    const spawned = observeReclamationWorkers();
    const context = new AsyncLocalStorage<number>();
    const diagnostics: SqliteSessionReclamationDiagnostics[] = [{}, {}];
    try {
      for (const [index, plan] of plans.entries()) {
        if (cold && index === 1) {
          expect(await closeOpenClawAgentDatabaseByPathAsync(database.path)).toBe(true);
          expect(spawned[0]?.threadId).toBe(-1);
        }
        let checks = 0;
        await expect(
          context.run(index, () =>
            runSqliteSessionReclamation({
              forceInProcess: false,
              plan,
              diagnostics: diagnostics[index],
              assertCommitAllowed: () => {
                checks += 1;
                expect(context.getStore()).toBe(index);
              },
            }),
          ),
        ).resolves.toMatchObject({ kind: "lifecycle-artifacts", value: { removedEntries: 1 } });
        expect(checks).toBeGreaterThan(1);
        expect(loadSessionEntryReadOnly(scopes[index]!)).toBeUndefined();
      }
      expect(spawned).toHaveLength(cold ? 2 : 1);
      expect(fullChecks()).toBe(1);
      expect(diagnostics[0]?.workerThreadId).toBeGreaterThan(0);
      if (cold) {
        expect(diagnostics[1]?.workerThreadId).not.toBe(diagnostics[0]?.workerThreadId);
      } else {
        expect(diagnostics[1]?.workerThreadId).toBe(diagnostics[0]?.workerThreadId);
      }
      if (cold) {
        expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      }
      expect(leasesFor(fixture)).toHaveLength(cold ? 1 : 2);
    } finally {
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
    }
    expect(spawned.every((worker) => worker.threadId === -1)).toBe(true);
    expect(leasesFor(fixture)).toHaveLength(0);
  },
);

test.each(["admission", "commit"] as const)(
  "rejects a revoked retained claim on the reused Worker's next %s",
  async (checkpoint) => {
    const { database, plans, scopes } = createFixture();
    await runSqliteSessionReclamation({ forceInProcess: false, plan: plans[0]! });
    const withWorker = reclamationWorker.withSqliteReclamationWorker;
    let revoked = false;
    let closeElapsedMs = 0;
    vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
      (options, claim, run, assertRequestCurrent) =>
        withWorker(
          options,
          claim,
          async (worker) => {
            const execute = worker.run.bind(worker);
            const spy = vi.spyOn(worker, "run").mockImplementation((params) =>
              execute({
                ...params,
                ...(checkpoint === "commit"
                  ? {
                      onCommitRequest: () => {
                        const started = performance.now();
                        revoked = closeOpenClawAgentDatabaseByPath(database.path);
                        closeElapsedMs = performance.now() - started;
                        return params.onCommitRequest();
                      },
                    }
                  : {
                      withWriteAdmission: async (...args) => {
                        revoked = closeOpenClawAgentDatabaseByPath(database.path);
                        return params.withWriteAdmission(...args);
                      },
                    }),
              }),
            );
            try {
              return await run(worker);
            } finally {
              spy.mockRestore();
            }
          },
          assertRequestCurrent,
        ),
    );
    await expect(
      runSqliteSessionReclamation({ forceInProcess: false, plan: plans[1]! }),
    ).rejects.toThrow("claim is no longer current");
    expect(revoked).toBe(true);
    if (checkpoint === "commit") {
      // A retained transaction must be signaled before native close can wait on its lock.
      expect(closeElapsedMs).toBeLessThan(2_000);
    }
    expect(loadSessionEntryReadOnly(scopes[0]!)).toBeUndefined();
    expect(loadSessionEntryReadOnly(scopes[1]!)).toMatchObject({ sessionId: "second" });
  },
);

test.each(["path", "root"] as const)(
  "joins queued cold reclamation before %s retirement returns",
  async (retirement) => {
    const fixture = createFixture();
    await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
    expect(getOpenClawAgentDatabaseIfOpen(fixture.options)).toBeUndefined();
    const spawned = observeReclamationWorkers();
    const enteredQueue = createDeferredCore();
    const releaseQueue = createDeferredCore();
    const enqueued = createDeferredCore();
    const observed: { claim?: OpenClawAgentDatabaseClaim } = {};
    const withWorker = reclamationWorker.withSqliteReclamationWorker;
    vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
      (options, claim, run, assertRequestCurrent) => {
        const result = withWorker(options, claim, run, assertRequestCurrent);
        observed.claim = claim;
        enqueued.resolve();
        return result;
      },
    );
    const holding = archiveWorker.runExclusiveSqliteTranscriptArchiveWorker(async () => {
      enteredQueue.resolve();
      await releaseQueue.promise;
    });
    await enteredQueue.promise;
    const request = runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[0]! });
    void request.catch(() => {});
    let closing: Promise<unknown> | undefined;
    try {
      await Promise.race([enqueued.promise, request]);
      expect(observed.claim?.isCurrent()).toBe(true);
      closing =
        retirement === "path"
          ? closeOpenClawAgentDatabaseByPathAsync(fixture.database.path)
          : closeOpenClawAgentDatabasesAsync(fixture.options.env.OPENCLAW_STATE_DIR);
      let closeSettled = false;
      void closing.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );
      await yieldToEventLoop();
      expect(closeSettled).toBe(false);
      releaseQueue.resolve();
      await expect(request).rejects.toThrow(/revoked|no longer current|admission.*changed/i);
      await closing;
      expect(observed.claim?.isCurrent()).toBe(false);
      expect(spawned).toHaveLength(0);
      expect(loadSessionEntryReadOnly(fixture.scopes[0]!)).toMatchObject({ sessionId: "first" });
      expect(leasesFor(fixture)).toHaveLength(0);
    } finally {
      releaseQueue.resolve();
      await Promise.allSettled([holding, request, ...(closing ? [closing] : [])]);
    }
  },
);

test("retires the previous database before opening a different agent store", async () => {
  const first = createFixture();
  const second = createFixture();
  invalidateOpenClawAgentDatabaseValidation(first.database.path);
  invalidateOpenClawAgentDatabaseValidation(second.database.path);
  const closeEntered = createDeferredCore();
  let closeRetained: (() => Promise<void>) | undefined;
  const withWorker = reclamationWorker.withSqliteReclamationWorker;
  vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
    (options, claim, run, assertRequestCurrent) =>
      withWorker(
        options,
        claim,
        async (worker) => {
          if (options.path === first.database.path) {
            const close = worker.close.bind(worker);
            closeRetained = close;
            vi.spyOn(worker, "close").mockImplementation(() => {
              const pending = close();
              closeEntered.resolve();
              return pending;
            });
          }
          return run(worker);
        },
        assertRequestCurrent,
      ),
  );
  let firstSpawned: Worker | undefined;
  let predecessorExitedAtSuccessorSpawn: boolean | undefined;
  const spawned = observeReclamationWorkers((worker) => {
    if (firstSpawned) {
      predecessorExitedAtSuccessorSpawn = firstSpawned.threadId === -1;
    } else {
      firstSpawned = worker;
    }
  });
  await runSqliteSessionReclamation({ forceInProcess: false, plan: first.plans[0]! });
  expect(leasesFor(first)).toHaveLength(2);
  const previous = spawned[0];
  const survivor = first.scopes[1];
  const retirePrevious = closeRetained;
  if (!previous || !survivor || !retirePrevious) {
    throw new Error("Expected the first real reclamation Worker and its retained owner");
  }
  const order: string[] = [];
  const exited = once(previous, "exit").then(() => {
    order.push("worker-exit");
  });
  void exited.catch(() => undefined);
  const options = { ...first.options, path: first.database.path };
  let followingWrite: Promise<unknown> | undefined;
  const postMessage = previous.postMessage.bind(previous);
  vi.spyOn(previous, "postMessage").mockImplementation((message: unknown, transferList) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "close"
    ) {
      order.push("close-dispatch");
      followingWrite = withOpenClawAgentDatabaseWrite(
        options,
        () => {
          order.push("following-write");
          return appendTranscriptEventSync(survivor, { type: "after-reclamation-close" });
        },
        first.database.db,
      );
      void followingWrite.catch(() => undefined);
    }
    postMessage(message, transferList);
  });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const holding = runOpenClawAgentWriteAdmission(options, async () => {
    order.push("foreground-enter");
    entered.resolve();
    await release.promise;
    order.push("foreground-release");
  });
  await entered.promise;
  const switching = runSqliteSessionReclamation({ forceInProcess: false, plan: second.plans[0]! });
  void switching.catch(() => undefined);
  try {
    await Promise.race([closeEntered.promise, switching]);
    await yieldToEventLoop();
  } finally {
    release.resolve();
    await Promise.allSettled([holding, switching]);
    await Promise.allSettled([retirePrevious(), exited]);
    if (followingWrite) {
      await Promise.allSettled([followingWrite]);
    }
  }
  await expect(switching).resolves.toMatchObject({
    kind: "lifecycle-artifacts",
    value: { removedEntries: 1 },
  });
  await expect(followingWrite).resolves.toEqual({ ok: true, value: true });
  expect({ order, predecessorExitedAtSuccessorSpawn }).toEqual({
    order: [
      "foreground-enter",
      "foreground-release",
      "close-dispatch",
      "worker-exit",
      "following-write",
    ],
    predecessorExitedAtSuccessorSpawn: true,
  });
  expect(spawned).toHaveLength(2);
  expect(fullChecks()).toBe(2);
  expect(spawned[0]?.threadId).toBe(-1);
  expect(leasesFor(first)).toHaveLength(1);
  expect(leasesFor(second)).toHaveLength(2);
  expect(loadSessionEntryReadOnly(first.scopes[1]!)).toMatchObject({ sessionId: "second" });
  expect(await loadTranscriptEvents(survivor)).toContainEqual({ type: "after-reclamation-close" });
  expect(loadSessionEntryReadOnly(second.scopes[1]!)).toMatchObject({ sessionId: "second" });
});

test("retires after thirty idle minutes and opens a new Worker for the next request", async () => {
  const fixture = createFixture(["first", "second", "third"]);
  invalidateOpenClawAgentDatabaseValidation(fixture.database.path);
  const spawned = observeReclamationWorkers();
  await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[0]! });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldClearNativeTimers: true });
  try {
    await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[1]! });
    expect(spawned).toHaveLength(1);
    expect(fullChecks()).toBe(1);
    const exited = once(spawned[0]!, "exit");
    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(spawned[0]?.threadId).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1);
    await exited;
  } finally {
    vi.useRealTimers();
  }
  expect(leasesFor(fixture)).toHaveLength(1);
  await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[2]! });
  expect(spawned).toHaveLength(2);
  expect(fullChecks()).toBe(1);
  expect(loadSessionEntryReadOnly(fixture.scopes[2]!)).toBeUndefined();
});

test("joins a crashed reused Worker, releases its exact lease, and preserves the uncommitted victim", async () => {
  const fixture = createFixture(["first", "second", "third"]);
  const spawned = observeReclamationWorkers();
  await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[0]! });
  const child = spawned[0]!;
  let terminated = false;
  child.prependListener("message", (message: { type: string; operationId?: number }) => {
    if (message.type === "admission-request" && message.operationId === 2 && !terminated) {
      terminated = true;
      void child.terminate();
    }
  });
  await expect(
    runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[1]! }),
  ).rejects.toThrow(/exited|uncertain/);
  expect(terminated).toBe(true);
  expect(child.threadId).toBe(-1);
  expect(leasesFor(fixture)).toHaveLength(1);
  expect(loadSessionEntryReadOnly(fixture.scopes[1]!)).toMatchObject({ sessionId: "second" });
  await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[2]! });
  expect(spawned).toHaveLength(2);
  expect(loadSessionEntryReadOnly(fixture.scopes[2]!)).toBeUndefined();
});

test("retains a crashed Worker's mismatched lease and retries only its restored receipt", async () => {
  const fixture = createFixture();
  let closeRetained: (() => Promise<void>) | undefined;
  const withWorker = reclamationWorker.withSqliteReclamationWorker;
  vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
    (options, claim, run, assertCurrent) =>
      withWorker(
        options,
        claim,
        async (worker) => {
          closeRetained = worker.close.bind(worker);
          return run(worker);
        },
        assertCurrent,
      ),
  );
  const received: { receipt?: OpenClawAgentDatabaseWorkerLeaseReceipt } = {};
  const spawned = observeReclamationWorkers((worker) => {
    worker.on("message", (message: reclamationWorker.SqliteReclamationWorkerMessage) => {
      if (message.type === "lease") {
        received.receipt = message.receipt;
      }
    });
  });
  await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[0]! });
  const retainedReceipt = received.receipt;
  const retireWorker = closeRetained;
  if (!retainedReceipt || !retireWorker) {
    throw new Error("Expected the real Worker's admitted lease receipt and retirement owner");
  }
  const child = spawned[0]!;
  await child.terminate();
  expect(child.threadId).toBe(-1);
  const kept = openOpenClawAgentDatabase({ ...fixture.options, agentId: "kept" });
  const state = openOpenClawStateDatabase({ env: fixture.options.env }).db;
  const readLeases = () =>
    state
      .prepare(
        "SELECT lease_id, agent_id, path, owner_pid, owner_start_time FROM agent_database_leases ORDER BY lease_id",
      )
      .all();
  const before = readLeases();
  expect(before).toContainEqual(expect.objectContaining({ lease_id: retainedReceipt.leaseId }));
  state
    .prepare("UPDATE agent_database_leases SET owner_pid = ? WHERE lease_id = ?")
    .run(retainedReceipt.ownerPid + 1, retainedReceipt.leaseId);
  try {
    const mismatched = readLeases();
    await expect(
      closeOpenClawAgentDatabaseByPathAsync(fixture.database.path),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: expect.stringContaining("receipt no longer matches") }),
      ],
    });
    expect(readLeases()).toEqual(mismatched);
    expect(fixture.database.db.isOpen).toBe(true);
    expect(kept.db.isOpen).toBe(true);
  } finally {
    state
      .prepare("UPDATE agent_database_leases SET owner_pid = ? WHERE lease_id = ?")
      .run(retainedReceipt.ownerPid, retainedReceipt.leaseId);
    try {
      // A live snapshot can still own this connection during native Worker retirement.
      const hostWrites = vi.spyOn(state, "exec").mockImplementation(() => {
        throw new Error("Reclamation cleanup accessed the live snapshot connection");
      });
      try {
        await retireWorker();
        expect(hostWrites).not.toHaveBeenCalled();
      } finally {
        hostWrites.mockRestore();
      }
      expect(readLeases()).toEqual(
        before.filter((row) => row.lease_id !== retainedReceipt.leaseId),
      );
      expect(fixture.database.db.isOpen).toBe(true);
    } finally {
      await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
    }
  }
  expect(readLeases()).toEqual(before.filter((row) => row.path === kept.path));
  expect(kept.db.isOpen).toBe(true);
});

test.each([false, true])(
  "reuses one Worker across history and cap-entry victims until lifecycle close (failure: %s)",
  async (failure) => {
    await withOpenClawTestState(
      { prefix: "reclamation-sweep-", layout: "state-only" },
      async (state) => {
        const sessionKey = "agent:main:explicit:sweep-lifetime";
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const databaseOptions = { agentId: "main", env: state.env };
        for (const [index, sessionId] of ["first", "second", "current"].entries()) {
          await replaceSessionEntry(
            { sessionKey, storePath },
            {
              sessionId,
              updatedAt: index + 1,
              ...(sessionId === "current"
                ? { archivedAt: 4, archiveReason: "active-session-cap" as const }
                : {}),
            },
          );
        }
        await closeOpenClawAgentDatabasesAsync(state.root);
        await reclaimSqliteFreePages(databaseOptions);
        const workers: Worker[] = [];
        const spawn = archiveWorker.createSqliteTranscriptArchiveWorker;
        vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation(
          (data) => {
            const worker = spawn(data);
            workers.push(worker);
            return worker;
          },
        );
        const run = reclamation.runSqliteSessionReclamation;
        vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
          if (
            failure &&
            params.plan.kind === "history-eviction" &&
            params.plan.sessionId === "second"
          ) {
            throw new Error("next victim preparation failed");
          }
          return run(params);
        });
        const sweep = enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
        });
        if (failure) {
          await expect(sweep).rejects.toThrow("next victim preparation failed");
        } else {
          const result = await sweep;
          expect(result?.removedEntries).toBe(3);
          expect(result?.totalBytesAfter).toBe(
            (await measureSessionPhysicalDiskUsage(storePath)).totalBytes,
          );
        }
        expect(
          openOpenClawAgentDatabase(databaseOptions)
            .db.prepare("SELECT session_id FROM session_windows ORDER BY session_id")
            .all(),
        ).toEqual(failure ? [{ session_id: "current" }, { session_id: "second" }] : []);
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBeGreaterThan(0);
        await closeOpenClawAgentDatabasesAsync(state.root);
        expect(workers[0]?.threadId).toBe(-1);
      },
    );
  },
);

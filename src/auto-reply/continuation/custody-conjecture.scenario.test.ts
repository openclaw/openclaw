/**
 * Conjecture tests for the post-TaskFlow continuation custody contract
 * (docs/design/continue-work-signal-v2.md §5.4 and §9.2.2).
 *
 * Every scenario drives public continuation boundaries: the continue_delegate,
 * continue_work and request_compaction tools, the response-token grammar, the
 * agent runner's post-turn scheduling seam, compaction release, session reset,
 * and the Gateway startup recovery passes. Outcomes are observed at owners
 * outside continuation custody: calls into the spawn owner, continuation turns
 * granted by the reply owner, durable session-delivery notices, and payload
 * bytes left on disk. Nothing here reads or writes TaskFlow rows or the future
 * `continuation_records` table, so the suite survives the custody re-home.
 *
 * A Gateway restart is a fresh module graph over the same state directory
 * (`vi.resetModules()` plus re-import): every process-local map, timer handle,
 * in-flight claim and drain coordinator is gone, and only durable state
 * carries over. Work abandoned by the "crashed" graph (a spawn that never
 * returns) stays suspended forever, exactly like a killed process.
 *
 * Where the RFC changed the TaskFlow-era behavior, the test name says which
 * section changed it; these were `it.fails` until the §5.4 custody store landed. Each
 * is paired with a test that pins the invariant both designs share, so a
 * changed-behavior test cannot pass because its scenario stopped reaching the
 * boundary.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSubagentDirectMock = vi.hoisted(() => vi.fn());
const getReplyFromConfigMock = vi.hoisted(() => vi.fn());

// The spawn owner is the boundary where "a child was started" is observable.
// mock-isolation: Spawn requests are recorded without starting real subagent runs.
vi.mock("../../agents/subagents/spawn/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));
// The reply owner is the boundary where "a continuation turn ran" is observable.
vi.mock("../reply/get-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reply/get-reply.js")>()),
  getReplyFromConfig: (...args: unknown[]) => getReplyFromConfigMock(...args),
}));

import {
  noopTracer,
  resetContinuationTracer,
  setContinuationTracer,
} from "../../infra/continuation-tracer.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureContinuationQueueContext } from "./queue-context.js";

const OWNER = "agent:main:discord:channel:custody-conjecture";
const OWNER_SESSION_ID = "custody-conjecture-owner-session";
const INTERRUPTED_NOTICE = "[continuation:delegate-spawn-interrupted]";
const START_MS = 1_800_000_000_000;
const CONFIG = {
  agents: { defaults: { continuation: { enabled: true } } },
  tools: { sessions_spawn: { attachments: { enabled: true } } },
};

type Gateway = Awaited<ReturnType<typeof bootGateway>>;

/** Interrupted notices delivered into memory before a crash, keyed by identity. */
const deliveredNoticeLedger = new Map<string, string>();

function recordNotices(
  notices: Map<string, string>,
  events: ReadonlyArray<{ id?: string; text: string; ts: number; sessionDeliveryAckId?: string }>,
): void {
  for (const event of events) {
    if (event.text.includes(INTERRUPTED_NOTICE)) {
      notices.set(
        event.sessionDeliveryAckId ?? event.id ?? `${event.ts}:${event.text}`,
        event.text,
      );
    }
  }
}

/**
 * Harness failures (tripwire, a turn that never reaches the spawn owner). They
 * are recorded here as well as thrown, because an `it.fails` test would absorb
 * the throw; the green `afterAll` below fails the file if any occurred.
 */
const harnessFaults: string[] = [];

function harnessFault(message: string): Error {
  harnessFaults.push(message);
  return new Error(message);
}
type DelegateForm = "tool" | "token";

async function bootGateway() {
  const [
    config,
    sessionPaths,
    accessor,
    delegateTool,
    workTool,
    compactionTool,
    custodyBoot,
    signal,
    schedule,
    controller,
    postCompaction,
    resetCleanup,
    replyRuns,
    deliveryStorage,
    sentinel,
    workerContext,
    systemEvents,
  ] = await Promise.all([
    import("../../config/config.js"),
    import("../../config/sessions.js"),
    import("../../config/sessions/session-accessor.js"),
    import("../../agents/tools/continue-delegate-tool.js"),
    import("../../agents/tools/continue-work-tool.js"),
    import("../../agents/tools/request-compaction-tool.js"),
    import("./custody-boot.js"),
    import("./signal.js"),
    import("../reply/agent-runner-continuation-schedule.js"),
    import("../reply/agent-runner-continuation.js"),
    import("../reply/post-compaction-delegate-dispatch.js"),
    import("../reply/session-reset-cleanup.js"),
    import("../../sessions/session-controller.js"),
    import("../../infra/session-delivery-queue-storage.js"),
    import("../../gateway/server-restart-sentinel.js"),
    import("../../state/openclaw-state-worker-context.js"),
    import("../../infra/system-events.js"),
  ]);
  config.setRuntimeConfigSnapshot(CONFIG as never);
  const storePath = sessionPaths.resolveSessionStorePathCore(undefined, { agentId: "main" });
  const loadOwnerEntry = () =>
    accessor.loadSessionEntry({
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
      sessionKey: OWNER,
      storePath,
    });

  /**
   * The continuation half of Gateway startup, in the order
   * `startPendingContinuationRecovery` (`server-runtime-services.ts`) runs it
   * with its boot-time cutoff: custody readiness, subagent registry activation
   * (this harness has no Gateway registry to activate), then custody recovery.
   */
  async function runContinuationRecovery(): Promise<void> {
    const armedAt = Date.now();
    await custodyBoot.runContinuationCustodyBoot({
      armedAt,
      whenSubagentRegistryActivated: async () => {},
    });
  }

  async function pendingOwnerDeliveries() {
    return (
      await deliveryStorage.loadPendingSessionDeliveries(captureContinuationQueueContext())
    ).filter((entry) => entry.sessionKey === OWNER);
  }

  function followupRun(runId: string) {
    return {
      prompt: "",
      summaryLine: "custody conjecture turn",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        sessionId: OWNER_SESSION_ID,
        sessionKey: OWNER,
        runId,
        workspaceDir: process.cwd(),
        config: config.getRuntimeConfig(),
        provider: "openai",
        model: "gpt-5.6-luna",
        timeoutMs: 30_000,
        blockReplyBreak: "message_end",
        skipProviderRuntimeHints: true,
      },
    } as never;
  }

  return {
    storePath,
    loadOwnerEntry,
    async seedOwnerSession(): Promise<void> {
      await accessor.replaceSessionEntry({ storePath, sessionKey: OWNER }, {
        sessionKey: OWNER,
        sessionId: OWNER_SESSION_ID,
        updatedAt: Date.now(),
        status: "done",
      } as never);
    },
    delegateTool(runId: string) {
      return delegateTool.createContinueDelegateTool({ agentSessionKey: OWNER, runId });
    },
    workTool(requests: Array<{ reason: string; delaySeconds: number }>) {
      return workTool.createContinueWorkTool({
        agentSessionKey: OWNER,
        requestContinuation: (request) => {
          requests.push(request);
        },
      });
    },
    compactionTool(triggerCompaction: () => Promise<{ ok: boolean; compacted: boolean }>) {
      return compactionTool.createRequestCompactionTool({
        agentSessionKey: OWNER,
        sessionId: OWNER_SESSION_ID,
        ownerAgentId: "main",
        getContextUsage: () => 0.95,
        triggerCompaction,
      });
    },
    /**
     * The agent runner's post-turn continuation seam: extract the response
     * token (or the turn's continue_work tool requests), admit it, and
     * dispatch any queued delegates, exactly as `completeReplyAgentRun` does.
     */
    async completeTurn(params: {
      runId: string;
      finalText: string;
      continueWorkRequests?: Array<{ reason: string; delaySeconds: number }>;
    }): Promise<void> {
      const requests = params.continueWorkRequests ?? [];
      const extraction = signal.extractContinuationSignal({
        payloads: [{ text: params.finalText }],
        ...(requests[0] ? { continueWorkRequest: requests[0] } : {}),
        enabled: true,
        sessionKey: OWNER,
      });
      let activeEntry = loadOwnerEntry();
      const continuation = controller.createReplyContinuationController({
        cfg: config.getRuntimeConfig(),
        sessionKey: OWNER,
        storePath,
        isContinuationWake: false,
        activeSessionStore: undefined,
        getActiveSessionEntry: () => activeEntry,
        setActiveSessionEntry: (entry) => {
          activeEntry = entry;
        },
      });
      await schedule.scheduleReplyContinuation({
        cfg: config.getRuntimeConfig(),
        sessionKey: OWNER,
        followupRun: followupRun(params.runId),
        runId: params.runId,
        usage: { input: 1, output: 1 },
        effectiveContinuationSignal: extraction.signal,
        continuationExtractionFromBracket: extraction.fromBracket,
        effectiveContinueWorkRequests: requests,
        continuationWorkReason: extraction.workReason,
        internalBracketTraceparent: undefined,
        continuation,
        getActiveSessionEntry: () => activeEntry,
      });
    },
    /** Compaction release, as the agent runner calls it after an auto-compaction. */
    async releaseAfterCompaction(runId: string): Promise<void> {
      await postCompaction.dispatchPostCompactionDelegates({
        cfg: config.getRuntimeConfig(),
        compactionCount: 1,
        followupRun: followupRun(runId),
        postCompactionDelegatesToPreserve: [],
        sessionEntry: loadOwnerEntry(),
        sessionKey: OWNER,
        storePath,
      });
    },
    /** Hold the owner's reply lane, as an in-flight agent turn does. */
    beginOwnerReplyRun() {
      return replyRuns.createReplyOperation({
        sessionKey: OWNER,
        sessionId: OWNER_SESSION_ID,
        agentId: "main",
        resetTriggered: false,
      });
    },
    // Awaited through Promise.resolve so the test stays valid if reset becomes
    // asynchronous with the custody store's worker APIs (§5.4.3).
    async resetOwnerSession(reason: "reset" | "delete" = "reset"): Promise<void> {
      await Promise.resolve(
        resetCleanup.clearSessionResetRuntimeState([OWNER], {
          agentId: "main",
          sessionKey: OWNER,
          assertCurrent: () => {},
          reason,
        }),
      );
    },
    /**
     * Gateway startup: session-delivery recovery (scheduled at +1250 ms), then
     * continuation recovery (+1400 ms) in `server-runtime-services.ts` order.
     */
    async runStartupRecovery(): Promise<void> {
      await sentinel.recoverPendingProducedSessionDeliveries({
        deps: {} as never,
        queueContext: workerContext.captureOpenClawStateWorkerContext(),
        log: { info: () => {}, warn: () => {}, error: () => {} },
        maxEnqueuedAt: Date.now(),
      });
      await runContinuationRecovery();
    },
    runContinuationRecovery,
    pendingOwnerDeliveries,
    /**
     * Interrupted-spawn notices the owner has been given, by identity. A notice
     * counts once whether it is still a pending durable row, was delivered into
     * the in-memory queue (keyed by the row it acks), or was delivered before an
     * earlier crash; two distinct notices always count twice.
     */
    async interruptedNotices(): Promise<string[]> {
      const notices = new Map(deliveredNoticeLedger);
      recordNotices(notices, systemEvents.peekSystemEventEntries(OWNER));
      for (const entry of await pendingOwnerDeliveries()) {
        if (entry.kind === "systemEvent" && entry.text.includes(INTERRUPTED_NOTICE)) {
          notices.set(entry.id, entry.text);
        }
      }
      return [...notices.values()];
    },
  };
}

/**
 * Drop everything a Gateway process holds in memory.
 *
 * A killed process cannot react to anything, so the dying graph's continuation
 * machinery (idle-retry waiters, work and hedge timers, dispatch claims) is
 * stopped first; otherwise its reply-run-ended waiter would wake on the reply
 * run eviction below and drive work from beyond the grave. The rest of
 * continuation's state is module-local and goes with the module graph. The
 * process-wide singletons a new process would not inherit are the Gateway
 * lifecycle generation (its rotation aborts prior-lifecycle reply runs), the
 * session controllers those runs stay registered in until their producers
 * settle (#175837), and the in-memory event queue.
 */
async function discardProcessState(): Promise<void> {
  const [continuationRuntime, delegateDispatch, agentEvents, systemEvents, sessionControllers] =
    await Promise.all([
      import("../../plugin-sdk/continuation-test-runtime.js"),
      import("./delegate-dispatch.js"),
      import("../../infra/agent-events.js"),
      import("../../infra/system-events.js"),
      import("../../sessions/session-controller.test-support.js"),
    ]);
  continuationRuntime.resetContinuationWorkDispatchForTests();
  continuationRuntime.resetContinueDelegateTurnAdmissionForTests();
  delegateDispatch.resetDelegateDispatchHedgesForTests();
  agentEvents.rotateAgentEventLifecycleGeneration();
  sessionControllers.testing.resetSessionControllerForTest();
  recordNotices(deliveredNoticeLedger, systemEvents.drainSystemEventEntries(OWNER));
  vi.resetModules();
}

function boundaryCallCounts() {
  return {
    spawns: spawnSubagentDirectMock.mock.calls.length,
    turns: getReplyFromConfigMock.mock.calls.length,
  };
}

/** A crash: discard process state and boot a fresh module graph over the same state dir. */
async function restartGateway(): Promise<Gateway> {
  const beforeCrash = boundaryCallCounts();
  await discardProcessState();
  const gateway = await bootGateway();
  // Anything the dead graph does after the crash would be a harness leak.
  const afterBoot = boundaryCallCounts();
  if (afterBoot.spawns !== beforeCrash.spawns || afterBoot.turns !== beforeCrash.turns) {
    throw harnessFault(
      `the crashed module graph acted after the crash: ${JSON.stringify({ beforeCrash, afterBoot })}`,
    );
  }
  return gateway;
}

async function withGateway(run: (gateway: Gateway, stateDir: string) => Promise<void>) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-continuation-custody-conjecture-" },
    async (state) => {
      await discardProcessState();
      deliveredNoticeLedger.clear();
      const gateway = await bootGateway();
      await gateway.seedOwnerSession();
      await run(gateway, state.stateDir);
    },
  );
}

function acceptSpawn() {
  let children = 0;
  return async () => {
    children += 1;
    return {
      status: "accepted" as const,
      childSessionKey: `agent:main:subagent:custody-child-${children}`,
      runId: `custody-child-run-${children}`,
    };
  };
}

/**
 * A spawn the process never returns from: the crash lands inside the spawn
 * owner, after continuation claimed the delegate. Whether the Gateway had
 * accepted the child (§5.4.4 boundary 3) or not (boundary 2) is invisible to
 * continuation at recovery, which is why Q3 treats both the same way.
 */
function crashInsideSpawn() {
  let entered!: () => void;
  const spawnEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hang = async () => {
    entered();
    return await new Promise<never>(() => {});
  };
  return { spawnEntered, hang };
}

function spawnedTasks(): string[] {
  return spawnSubagentDirectMock.mock.calls.map(([params]) => (params as { task: string }).task);
}

function continuationWakeTurns(): string[] {
  return getReplyFromConfigMock.mock.calls
    .map(([ctx]) => (ctx as { Body?: string }).Body ?? "")
    .filter((body) => body.startsWith("[continuation:wake]"));
}

/**
 * The spawn request with per-record identity (record id, chain position, trace)
 * removed. `ownerEpoch` also masks the owner session's recipient-authority
 * epoch, which differs between two owner incarnations.
 */
function spawnProjection(call: unknown[] | undefined, options: { ownerEpoch?: "mask" } = {}) {
  const [request, context] = (call ?? []) as [Record<string, unknown>, Record<string, unknown>];
  const { continuationChainState: _chain, traceparent: _trace, task, ...rest } = request;
  // Record identity (today `continuationDelegateFlowId`) is dropped by shape so
  // a renamed record-id field after the re-home is still ignored. The launch
  // key (§5.4.4) embeds that identity; only its attempt number is compared.
  const stable = Object.fromEntries(
    Object.entries(rest)
      .filter(([key]) => !/(flow|record)Id$/i.test(key))
      .map(([key, value]) => [
        key,
        key === "continuationChildRunId" && typeof value === "string"
          ? value.replace(/^continuation:.+:(\d+)$/, "continuation:<record>:$1")
          : value,
      ]),
  );
  const projected = {
    request: {
      ...stable,
      task: String(task).replace(/^\[continuation:chain-hop:\d+\] Delegated task \(turn \d+\//, ""),
    },
    requesterSessionKey: context.agentSessionKey,
  };
  if (options.ownerEpoch !== "mask") {
    return projected;
  }
  return JSON.parse(
    JSON.stringify(projected, (key, value: unknown) => (key === "epoch" ? "<owner-epoch>" : value)),
  ) as typeof projected;
}

function filesUnder(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? filesUnder(full) : entry.isFile() ? [full] : [];
  });
}

/** Every file in durable state that still holds the given bytes, raw or base64. */
function durableFilesHolding(stateDir: string, canary: string): string[] {
  const needles = [Buffer.from(canary), Buffer.from(Buffer.from(canary).toString("base64"))];
  return filesUnder(stateDir).filter((file) => {
    const bytes = fs.readFileSync(file);
    return needles.some((needle) => bytes.includes(needle));
  });
}

async function electDelegate(
  gateway: Gateway,
  form: DelegateForm,
  params: {
    runId: string;
    task: string;
    delaySeconds: number;
    mode?: string;
    /** Tool form only: the token grammar carries no attachments (§9.2 attachment-free policy). */
    attachmentCanary?: string;
  },
): Promise<void> {
  if (form === "tool") {
    await gateway.delegateTool(params.runId).execute(`${params.runId}-call`, {
      task: params.task,
      delaySeconds: params.delaySeconds,
      ...(params.mode ? { mode: params.mode } : {}),
      ...(params.attachmentCanary
        ? {
            attachments: [
              { name: "notes.txt", content: params.attachmentCanary, encoding: "utf8" },
            ],
          }
        : {}),
    });
    await gateway.completeTurn({ runId: params.runId, finalText: "turn done" });
    return;
  }
  const delay = params.delaySeconds > 0 ? ` +${params.delaySeconds}s` : "";
  const mode = params.mode ? ` | ${params.mode}` : "";
  await gateway.completeTurn({
    runId: params.runId,
    finalText: `turn done\n[[CONTINUE_DELEGATE: ${params.task}${delay}${mode}]]`,
  });
}

/** Run a turn whose due delegate is claimed and then crashes inside the spawn. */
async function crashWhileClaimed(
  gateway: Gateway,
  form: DelegateForm,
  options: { attachmentCanary?: string } = {},
): Promise<void> {
  const crash = crashInsideSpawn();
  spawnSubagentDirectMock.mockImplementationOnce(crash.hang);
  const turn = electDelegate(gateway, form, {
    runId: `claimed-${form}`,
    task: "publish the release notes",
    delaySeconds: 0,
    ...(form === "tool" && options.attachmentCanary
      ? { attachmentCanary: options.attachmentCanary }
      : {}),
  });
  await Promise.race([
    crash.spawnEntered,
    turn.then(() => {
      throw harnessFault("the turn finished without reaching the spawn owner");
    }),
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(START_MS);
  spawnSubagentDirectMock.mockImplementation(acceptSpawn());
  getReplyFromConfigMock.mockImplementation(async () => ({ text: "continued" }));
});

afterEach(() => {
  spawnSubagentDirectMock.mockReset();
  getReplyFromConfigMock.mockReset();
  vi.useRealTimers();
});

afterAll(() => {
  expect(harnessFaults, "harness faults, including inside expected-red tests").toEqual([]);
});

describe("RFC §5.4.4 pre-spawn custody handoff: an unresolved claim is at-most-once (Q3)", () => {
  const CLAIM_CANARY = "custody-conjecture-claimed-attachment-canary-2c81d4";

  it.each(["tool", "token"] as const)(
    "[§5.4 re-home] %s form, boundary 2/3: restart spawns no second child, leaves exactly one interrupted notice, and releases the payload",
    async (form) => {
      await withGateway(async (gateway, stateDir) => {
        await crashWhileClaimed(gateway, form, { attachmentCanary: CLAIM_CANARY });
        expect(spawnedTasks()).toHaveLength(1);
        if (form === "tool") {
          expect(durableFilesHolding(stateDir, CLAIM_CANARY)).not.toEqual([]);
        }

        let restarted = await restartGateway();
        await restarted.runStartupRecovery();

        // C re-dispatched the `running` row and spawned a second child.
        expect(spawnedTasks()).toHaveLength(1);
        const notices = await restarted.interruptedNotices();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("publish the release notes");
        expect(durableFilesHolding(stateDir, CLAIM_CANARY)).toEqual([]);

        // The notice stays single across a second restart.
        restarted = await restartGateway();
        await restarted.runStartupRecovery();
        expect(spawnedTasks()).toHaveLength(1);
        expect(await restarted.interruptedNotices()).toHaveLength(1);
      });
    },
  );

  it.each(["tool", "token"] as const)(
    "%s form, boundary 2/3: the claimed delegate is never silently dropped by a restart (§5.4.9 item 1)",
    async (form) => {
      await withGateway(async (gateway) => {
        await crashWhileClaimed(gateway, form);

        const restarted = await restartGateway();
        await restarted.runStartupRecovery();

        // C replays the claim; the re-home reports it. Either is visible.
        const replayed = spawnedTasks().length > 1;
        const reported = (await restarted.interruptedNotices()).length === 1;
        expect(replayed || reported).toBe(true);
      });
    },
  );
});

describe("RFC §5.4.9 item 1: queued work survives a restart until it is claimed", () => {
  it.each(["tool", "token"] as const)(
    "a queued %s-form continue_delegate spawns exactly once after a restart, at its due time",
    async (form) => {
      await withGateway(async (gateway) => {
        await electDelegate(gateway, form, {
          runId: `queued-${form}`,
          task: "reconcile the ledger",
          delaySeconds: 60,
        });
        expect(spawnedTasks()).toEqual([]);

        let restarted = await restartGateway();
        await restarted.runStartupRecovery();
        expect(spawnedTasks()).toEqual([]);

        vi.setSystemTime(START_MS + 61_000);
        restarted = await restartGateway();
        await restarted.runStartupRecovery();
        expect(spawnedTasks()).toHaveLength(1);
        expect(spawnedTasks()[0]).toContain("reconcile the ledger");

        restarted = await restartGateway();
        await restarted.runStartupRecovery();
        expect(spawnedTasks()).toHaveLength(1);
      });
    },
  );

  it.each(["tool", "token"] as const)(
    "a queued %s-form continue_work election fires exactly one turn after a restart, at its due time",
    async (form) => {
      await withGateway(async (gateway) => {
        if (form === "tool") {
          const requests: Array<{ reason: string; delaySeconds: number }> = [];
          await gateway
            .workTool(requests)
            .execute("work-call", { reason: "finish the audit", delaySeconds: 60 });
          await gateway.completeTurn({
            runId: "work-tool",
            finalText: "turn done",
            continueWorkRequests: requests,
          });
        } else {
          await gateway.completeTurn({
            runId: "work-token",
            finalText: "turn done\nCONTINUE_WORK:60",
          });
        }

        let restarted = await restartGateway();
        await restarted.runStartupRecovery();
        expect(continuationWakeTurns()).toEqual([]);

        vi.setSystemTime(START_MS + 61_000);
        restarted = await restartGateway();
        await restarted.runStartupRecovery();
        expect(continuationWakeTurns()).toHaveLength(1);

        restarted = await restartGateway();
        await restarted.runStartupRecovery();
        expect(continuationWakeTurns()).toHaveLength(1);
      });
    },
  );
});

describe("RFC §5.4.3 election replacement is one atomic owner-conditioned commit", () => {
  // An election made while its turn is still running is parked until that turn
  // ends, with its hedge due at maxDelayMs (300 s by default). A later election
  // for the same session supersedes the parked one. Recovering just after the
  // hedge is inside the dispatcher's backlog-fold grace (2 x maxDelayMs), so a
  // second live election would fire its own turn instead of being folded.
  const PARKED_HEDGE_DUE_MS = START_MS + 300_000;
  async function electWhileOwnerBusy(gateway: Gateway, runId: string, reason: string) {
    const requests: Array<{ reason: string; delaySeconds: number }> = [];
    await gateway.workTool(requests).execute(`${runId}-call`, { reason, delaySeconds: 0 });
    await gateway.completeTurn({ runId, finalText: "turn done", continueWorkRequests: requests });
  }

  it("a crash right after the replacement commits leaves exactly one live election, the replacement", async () => {
    await withGateway(async (gateway) => {
      gateway.beginOwnerReplyRun();
      await electWhileOwnerBusy(gateway, "turn-a", "parked follow-up");
      await electWhileOwnerBusy(gateway, "turn-b", "replacement follow-up");

      vi.setSystemTime(PARKED_HEDGE_DUE_MS + 1_000);
      let restarted = await restartGateway();
      await restarted.runStartupRecovery();
      const wakes = continuationWakeTurns();
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("replacement follow-up");
      expect(wakes[0]).not.toContain("parked follow-up");

      restarted = await restartGateway();
      await restarted.runStartupRecovery();
      expect(continuationWakeTurns()).toHaveLength(1);
    });
  });

  it("the pre-replacement state: a crash before the second election leaves exactly the parked election live", async () => {
    await withGateway(async (gateway) => {
      gateway.beginOwnerReplyRun();
      await electWhileOwnerBusy(gateway, "turn-a", "parked follow-up");

      vi.setSystemTime(PARKED_HEDGE_DUE_MS + 1_000);
      const restarted = await restartGateway();
      await restarted.runStartupRecovery();
      const wakes = continuationWakeTurns();
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("parked follow-up");
    });
  });
});

describe("RFC §5.4.2 / §9.2.2 item 4: post-compaction release and queue insert", () => {
  async function releaseAndCrashInsideDrain(gateway: Gateway, form: DelegateForm) {
    await electDelegate(gateway, form, {
      runId: `staged-${form}`,
      task: "carry the working state",
      delaySeconds: 0,
      mode: "post-compaction",
    });
    expect(spawnedTasks()).toEqual([]);
    const crash = crashInsideSpawn();
    spawnSubagentDirectMock.mockImplementationOnce(crash.hang);
    await gateway.releaseAfterCompaction(`compaction-${form}`);
    await crash.spawnEntered;
  }

  it.each(["tool", "token"] as const)(
    "%s form: a crash after the release commits re-releases nothing from the staged delegate",
    async (form) => {
      await withGateway(async (gateway) => {
        await releaseAndCrashInsideDrain(gateway, form);
        expect(spawnedTasks()).toHaveLength(1);

        const restarted = await restartGateway();
        // Continuation recovery must not release the staged delegate a second
        // time; the queue entry is the only remaining custody.
        await restarted.runContinuationRecovery();
        expect(spawnedTasks()).toHaveLength(1);
        const queued = (await restarted.pendingOwnerDeliveries()).filter(
          (entry) => entry.kind === "postCompactionDelegate",
        );
        expect(queued).toHaveLength(1);
      });
    },
  );

  it.each(["tool", "token"] as const)(
    "[§5.4 re-home] %s form: redelivery after a crash inside the drain's spawn starts no second child and leaves exactly one interrupted notice (§5.4.4 post-compaction handoff)",
    async (form) => {
      await withGateway(async (gateway) => {
        await releaseAndCrashInsideDrain(gateway, form);

        let restarted = await restartGateway();
        await restarted.runStartupRecovery();

        // C's drain redelivered the entry and spawned a second child.
        expect(spawnedTasks()).toHaveLength(1);
        const notices = await restarted.interruptedNotices();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("carry the working state");

        restarted = await restartGateway();
        await restarted.runStartupRecovery();
        expect(spawnedTasks()).toHaveLength(1);
        expect(await restarted.interruptedNotices()).toHaveLength(1);
      });
    },
  );

  it.each(["tool", "token"] as const)(
    "%s form: a released delegate whose drain crashed is never silently dropped by a restart",
    async (form) => {
      await withGateway(async (gateway) => {
        await releaseAndCrashInsideDrain(gateway, form);

        const restarted = await restartGateway();
        await restarted.runStartupRecovery();

        const replayed = spawnedTasks().length > 1;
        const reported = (await restarted.interruptedNotices()).length === 1;
        expect(replayed || reported).toBe(true);
      });
    },
  );

  it("tool form: a released delegate fires once across a crash inside the drain's spawn and a restart (#1497)", async () => {
    // The tracer registry is process-wide, so it outlives the module graph a restart replaces.
    const fires: unknown[] = [];
    setContinuationTracer({
      startSpan: (name, options) => {
        if (name === "continuation.delegate.fire") {
          fires.push(options?.attributes?.["delegate.mode"]);
        }
        return noopTracer.startSpan(name, options);
      },
    });
    try {
      await withGateway(async (gateway) => {
        await releaseAndCrashInsideDrain(gateway, "tool");
        expect(fires).toEqual(["post-compaction"]);

        const restarted = await restartGateway();
        await restarted.runStartupRecovery();
        expect(spawnedTasks()).toHaveLength(1);
        expect(fires).toEqual(["post-compaction"]);
      });
    } finally {
      resetContinuationTracer();
    }
  });
});

describe("RFC §5.4.4 reset at any boundary", () => {
  const CANARY = "custody-conjecture-attachment-canary-7f3e9b";

  async function queueWorkAndAttachedDelegate(gateway: Gateway) {
    await gateway.delegateTool("reset-tool").execute("reset-tool-call", {
      task: "review the attached notes",
      delaySeconds: 60,
      attachments: [{ name: "notes.txt", content: CANARY, encoding: "utf8" }],
    });
    await gateway.completeTurn({
      runId: "reset-token",
      finalText: "turn done\n[[CONTINUE_DELEGATE: token delegate before reset +60s]]",
    });
    const requests: Array<{ reason: string; delaySeconds: number }> = [];
    await gateway
      .workTool(requests)
      .execute("reset-work-call", { reason: "election before reset", delaySeconds: 60 });
    await gateway.completeTurn({
      runId: "reset-work",
      finalText: "turn done",
      continueWorkRequests: requests,
    });
    await gateway.completeTurn({
      runId: "reset-work-token",
      finalText: "turn done\nCONTINUE_WORK:90",
    });
  }

  it("control: without a reset, the same queued work all fires after a restart", async () => {
    await withGateway(async (gateway) => {
      await queueWorkAndAttachedDelegate(gateway);

      vi.setSystemTime(START_MS + 91_000);
      const restarted = await restartGateway();
      await restarted.runStartupRecovery();
      expect(spawnedTasks()).toHaveLength(2);
      expect(continuationWakeTurns()).toHaveLength(2);
    });
  });

  // karmaterminal/openclaw#1271: a head swap is not a decision to cancel.
  it("reset keeps queued delegates and elections from both forms with their attachment; each fires once after restarts", async () => {
    await withGateway(async (gateway, stateDir) => {
      await queueWorkAndAttachedDelegate(gateway);
      expect(durableFilesHolding(stateDir, CANARY)).not.toEqual([]);

      await gateway.resetOwnerSession();

      expect(durableFilesHolding(stateDir, CANARY)).not.toEqual([]);
      vi.setSystemTime(START_MS + 91_000);
      let restarted = await restartGateway();
      await restarted.runStartupRecovery();
      expect(spawnedTasks()).toHaveLength(2);
      expect(continuationWakeTurns()).toHaveLength(2);

      restarted = await restartGateway();
      await restarted.runStartupRecovery();
      expect(spawnedTasks()).toHaveLength(2);
      expect(continuationWakeTurns()).toHaveLength(2);
    });
  });

  it("a claimed delegate (boundary 2/3) that reset keeps spawns no second child after a restart, and the payload is gone", async () => {
    await withGateway(async (gateway, stateDir) => {
      const canary = "custody-conjecture-reset-claimed-canary-91b0e7";
      await crashWhileClaimed(gateway, "tool", { attachmentCanary: canary });
      expect(durableFilesHolding(stateDir, canary)).not.toEqual([]);

      await gateway.resetOwnerSession();

      let restarted = await restartGateway();
      await restarted.runStartupRecovery();
      expect(spawnedTasks()).toHaveLength(1);
      expect(durableFilesHolding(stateDir, canary)).toEqual([]);

      restarted = await restartGateway();
      await restarted.runStartupRecovery();
      expect(spawnedTasks()).toHaveLength(1);
    });
  });

  it("[§5.4 re-home] delete releases the attachment payload immediately, not at the next startup (§5.4.9 item 6)", async () => {
    await withGateway(async (gateway, stateDir) => {
      await queueWorkAndAttachedDelegate(gateway);
      expect(durableFilesHolding(stateDir, CANARY)).not.toEqual([]);

      await gateway.resetOwnerSession("delete");

      // At C the payload file waited for the startup custody reconcile.
      expect(durableFilesHolding(stateDir, CANARY)).toEqual([]);
    });
  });
});

describe("RFC §2.2/§2.6 tool and token forms converge on one custody record (§9.2.2 item 5)", () => {
  it("a delayed delegate reaches the spawn owner identically from the tool and the token form", async () => {
    await withGateway(async (gateway) => {
      for (const form of ["tool", "token"] as const) {
        await electDelegate(gateway, form, {
          runId: `parity-${form}`,
          task: "summarize the incident",
          delaySeconds: 60,
          mode: "silent-wake",
        });
      }
      vi.setSystemTime(START_MS + 61_000);
      const restarted = await restartGateway();
      await restarted.runStartupRecovery();

      expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(2);
      const [fromTool, fromToken] = spawnSubagentDirectMock.mock.calls.map((call) =>
        spawnProjection(call),
      );
      expect(fromTool).toEqual(fromToken);
      expect(fromTool?.request).toMatchObject({ silentAnnounce: true, wakeOnReturn: true });
    });
  });

  it("a post-compaction delegate reaches the spawn owner identically from the tool and the token form", async () => {
    const projections: Array<ReturnType<typeof spawnProjection>> = [];
    for (const form of ["tool", "token"] as const) {
      await withGateway(async (gateway) => {
        await electDelegate(gateway, form, {
          runId: "parity",
          task: "restore the plan",
          delaySeconds: 0,
          mode: "post-compaction",
        });
        const crash = crashInsideSpawn();
        spawnSubagentDirectMock.mockImplementationOnce(crash.hang);
        await gateway.releaseAfterCompaction("parity-compaction");
        await crash.spawnEntered;
        projections.push(
          spawnProjection(spawnSubagentDirectMock.mock.calls[0], { ownerEpoch: "mask" }),
        );
      });
      spawnSubagentDirectMock.mockClear();
    }
    expect(projections).toHaveLength(2);
    expect(projections[0]).toEqual(projections[1]);
  });

  it("a delayed continue_work election wakes the session identically from the tool and the token form", async () => {
    const wakes: string[] = [];
    for (const form of ["tool", "token"] as const) {
      await withGateway(async (gateway) => {
        if (form === "tool") {
          const requests: Array<{ reason: string; delaySeconds: number }> = [];
          await gateway
            .workTool(requests)
            .execute("parity-work", { reason: "finish the audit", delaySeconds: 60 });
          await gateway.completeTurn({
            runId: "parity",
            finalText: "turn done",
            continueWorkRequests: requests,
          });
        } else {
          await gateway.completeTurn({ runId: "parity", finalText: "turn done\nCONTINUE_WORK:60" });
        }
        vi.setSystemTime(START_MS + 61_000);
        const restarted = await restartGateway();
        await restarted.runStartupRecovery();
        expect(continuationWakeTurns()).toHaveLength(1);
        // Only the tool form carries a reason; provenance names per-record ids.
        wakes.push(
          (continuationWakeTurns()[0] ?? "").replace(/ (Prior reason:|\[provenance\]).*$/, ""),
        );
      });
      getReplyFromConfigMock.mockClear();
      vi.setSystemTime(START_MS);
    }
    expect(wakes).toHaveLength(2);
    expect(wakes[0]).toBe(wakes[1]);
    expect(wakes[0]).toMatch(/^\[continuation:wake\] Turn 1\//);
  });
});

describe("RFC §2.5 / §5.4 unchanged: request_compaction has no durable custody", () => {
  it("a compaction request in flight at a crash leaves nothing to replay", async () => {
    await withGateway(async (gateway) => {
      const triggerCompaction = vi.fn(() => new Promise<never>(() => {}));
      const result = await gateway
        .compactionTool(triggerCompaction)
        .execute("compact-call", { reason: "context pressure at 95%" });
      expect(result.details).toMatchObject({ status: "compaction_requested" });
      expect(triggerCompaction).toHaveBeenCalledTimes(1);

      const restarted = await restartGateway();
      await restarted.runStartupRecovery();
      expect(triggerCompaction).toHaveBeenCalledTimes(1);
      expect(await restarted.pendingOwnerDeliveries()).toEqual([]);
      expect(spawnedTasks()).toEqual([]);
      expect(continuationWakeTurns()).toEqual([]);
    });
  });
});

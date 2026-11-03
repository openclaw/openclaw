// Continuation wake over upstream's session-event handoff (continuation-wake.ts).
//
// Real: the continuation producer (durable row + managed system event), the wake's
// coalescing and claims, the session-event handoff, ordinary reply admission, the
// continuation chain-budget gate, restart replay and the durable session-delivery queue.
// Only the model decision (runEmbeddedAgent) is synthetic.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  admitModelTurn,
  completionConfig,
} from "../../agents/bash-tools.lifecycle.test-support.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  assignSessionOwner,
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-writable.js";
import { readSessionHistoryPageInWorker } from "../../config/sessions/session-history-worker-runtime.js";
import { captureSessionRecipientAuthority } from "../../config/sessions/session-sharing-store.async.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recoverPendingProducedSessionDeliveries } from "../../gateway/server-restart-sentinel.js";
import {
  resetContinuationTracer,
  setContinuationTracer,
  type StartSpanOptions,
} from "../../infra/continuation-tracer.js";
import { loadPendingSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import { isDeliveryAdoptionClaimed } from "../../infra/system-event-delivery-claims.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import {
  isSystemEventTurnOwned,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { markUserTurnInputDispatched } from "../../sessions/user-turn-transcript-input-run.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { getReplyFromConfig } from "../reply/get-reply.js";
import { enqueueSessionEventForHost } from "../reply/session-event-handoff.js";
import type { MsgContext } from "../templating.js";
import {
  requestContinuationWake,
  resetContinuationWakesForTest,
  settleContinuationWakesForTest,
} from "./continuation-wake.js";
import { enqueueContinuationReturnDeliveries } from "./targeting.js";

// mock-isolation: Synthetic model decisions; admission, queue, handoff and durable rows stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
const failingAcks = vi.hoisted(() => new Set<string>());
const ackedRows = vi.hoisted(() => new Set<string>());
// Durable acks and refusals stay real unless a case arms a failing row.
vi.mock("../../infra/session-delivery-queue-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/session-delivery-queue-storage.js")>();
  const failFor = (id: string) => {
    if (failingAcks.has(id)) {
      throw new Error(`settlement failed for ${id}`);
    }
  };
  return {
    ...actual,
    ackSessionDelivery: async (...args: Parameters<typeof actual.ackSessionDelivery>) => {
      failFor(args[0]);
      ackedRows.add(args[0]);
      return await actual.ackSessionDelivery(...args);
    },
    moveSessionDeliveryToFailed: async (
      ...args: Parameters<typeof actual.moveSessionDeliveryToFailed>
    ) => {
      failFor(args[0]);
      return await actual.moveSessionDeliveryToFailed(...args);
    },
  };
});
const warnings = vi.hoisted(() => [] as string[]);
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      const warn = (message: string, meta?: Record<string, unknown>) => {
        warnings.push(message);
        logger.warn(message, meta);
      };
      return { ...logger, warn };
    },
  };
});
const failingStamp = vi.hoisted(() => ({ armed: false }));
// At-anchor rewrites stay real unless a case arms the consuming-run stamp's write to fail.
vi.mock("../../config/sessions/session-message-rewrite.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../config/sessions/session-message-rewrite.js")>();
  return {
    ...actual,
    rewritePreparedTranscriptMessageAtAnchor: async (
      ...args: Parameters<typeof actual.rewritePreparedTranscriptMessageAtAnchor>
    ) => {
      if (failingStamp.armed) {
        throw new Error("synthetic stamp write failure");
      }
      return await actual.rewritePreparedTranscriptMessageAtAnchor(...args);
    },
  };
});
// Match Gateway startup: activate the real reply runtimes before admitting turns.
await Promise.all([
  import("../dispatch.js"),
  import("../reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

const AGENT_ID = "main";
const ROUTE = { channel: "telegram", to: "-100001", accountId: "default" };

afterEach(() => {
  failingAcks.clear();
  ackedRows.clear();
  warnings.length = 0;
  failingStamp.armed = false;
  resetContinuationWakesForTest();
  resetSystemEventsForTest();
  runEmbeddedAgentMock.mockReset();
});

type Fixture = {
  sessionKey: string;
  sendText: ReturnType<typeof vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>>;
  prompts: string[];
};

/** A continuation-enabled session with a mid-chain budget and a transport route. */
async function withWakeFixture(
  label: string,
  run: (fixture: Fixture) => Promise<void>,
  options: { session?: false; sessionKey?: string } = {},
) {
  await withOpenClawTestState({ label, env: { OPENCLAW_TEST_FAST: "0" } }, async (state) => {
    const config: OpenClawConfig = completionConfig(state.workspaceDir);
    config.agents = {
      ...config.agents,
      defaults: { ...config.agents?.defaults, continuation: { enabled: true } },
    };
    setRuntimeConfigSnapshot(config);
    await state.writeConfig(config);
    openOpenClawStateDatabase();
    const registry = captureActivePluginRegistrySnapshot();
    const current = expectDefined(registry.activeRegistry, "active plugin registry");
    const sendText = vi
      .fn<NonNullable<ChannelOutboundAdapter["sendText"]>>()
      .mockResolvedValue({ channel: "telegram", messageId: "wake-reply" });
    const channels = createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram" }),
          outbound: { deliveryMode: "direct", sendText },
        } satisfies ChannelPlugin,
      },
    ]);
    setActivePluginRegistry({
      ...current,
      channels: [
        ...current.channels.filter((entry) => entry.plugin.id !== "telegram"),
        ...channels.channels,
      ],
      channelSetups: [
        ...current.channelSetups.filter((entry) => entry.plugin.id !== "telegram"),
        ...channels.channelSetups,
      ],
    });
    const sessionKey = options.sessionKey ?? `agent:main:wake-${label}`;
    if (options.session !== false) {
      await replaceSessionEntry(
        { agentId: AGENT_ID, sessionKey },
        {
          sessionId: `session-${label}`,
          lifecycleRevision: "original",
          permissionMode: "full",
          delivery: normalizeSessionDeliveryState({ context: ROUTE }),
          continuationChainCount: 2,
          continuationChainTokens: 1_000,
          continuationChainStartedAt: 1,
          continuationChainId: "chain-before-wake",
          updatedAt: Date.now(),
        },
      );
    }
    const prompts: string[] = [];
    try {
      await run({ sessionKey, sendText, prompts });
    } finally {
      restoreActivePluginRegistrySnapshot(registry);
    }
  });
}

/** What the embedded runner settles when the model ends its turn with `NO_REPLY`. */
function silentTerminal(): EmbeddedAgentRunResult {
  return { payloads: [], meta: { durationMs: 1, terminalReply: { disposition: "silent" } } };
}

/**
 * Runs the turn in the runner's order: its input commits, its request is sent, and the provider
 * accepts it. The accepted-dispatch boundary itself is proven at the attempt and worker owners.
 */
async function admitWokenTurn(params: RunEmbeddedAgentParams) {
  await admitModelTurn(params);
  params.userTurnTranscriptRecorder?.markSentToProvider?.();
  markUserTurnInputDispatched(params.userTurnTranscriptRecorder);
  await params.userTurnTranscriptRecorder?.waitForRuntimePersistence();
}

/** The model answers every turn with `reply`, or ends it silently for `NO_REPLY`. */
function answerTurns(prompts: string[], reply: string) {
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
    prompts.push(params.prompt);
    await admitWokenTurn(params);
    return reply === "NO_REPLY"
      ? silentTerminal()
      : {
          payloads: [{ text: reply }],
          meta: { durationMs: 1, terminalReply: { disposition: "visible", text: reply } },
        };
  });
}

/** One durable delegate return through the real producer, waking its recipient. */
async function produceReturn(
  sessionKey: string,
  text: string,
  extra: Partial<Parameters<typeof enqueueContinuationReturnDeliveries>[0]> = {},
) {
  const outcome = await enqueueContinuationReturnDeliveries({
    targetSessionKeys: [sessionKey],
    text,
    // Restart replay recognizes a continuation return by its producer's key prefix.
    idempotencyKeyBase: `continuation-return:${text}`,
    wakeRecipients: true,
    childRunId: `child-run:${text}`,
    recipientAgentIds: new Map([[sessionKey, AGENT_ID]]),
    ownerAgentId: AGENT_ID,
    ...extra,
  });
  return expectDefined(outcome.deliveryIds[0], "durable return row");
}

/** The first turn holds the session busy until released; every turn ends silently. */
function holdFirstTurn(prompts: string[]) {
  const started = createDeferred();
  const released = createDeferred();
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
    prompts.push(params.prompt);
    await admitWokenTurn(params);
    if (prompts.length === 1) {
      started.resolve();
      await released.promise;
    }
    return silentTerminal();
  });
  return { started: started.promise, release: () => released.resolve() };
}

/** Resolves once the row's queued event is handed to a turn (owned, not yet adopted). */
function handedOff(sessionKey: string, row: string) {
  const queueKey = resolveSystemEventQueueKey(sessionKey, AGENT_ID);
  return vi.waitFor(() =>
    expect(
      peekSystemEventEntries(queueKey).some(
        (event) => event.sessionDeliveryAckId === row && isSystemEventTurnOwned(queueKey, event),
      ),
    ).toBe(true),
  );
}

async function rowPending(id: string) {
  return (await loadPendingSessionDelivery(id, captureOpenClawStateWorkerContext())) !== null;
}

type StoredUserRow = {
  provenance?: { kind?: string; sourceTool?: string; runId?: string };
  __openclaw?: Record<string, unknown>;
};

/** An operator's direct message on the session's route. */
function operatorMessage(sessionKey: string): MsgContext {
  return {
    Body: "what did the delegate find?",
    SessionKey: sessionKey,
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: ROUTE.to,
    AccountId: ROUTE.accountId,
    ChatType: "direct",
    From: "telegram:operator",
    SenderId: "operator",
    CommandAuthorized: true,
  };
}

/** The session's user rows as sessions.get returns them: its unprojected stored-transcript read. */
async function readStoredUserRows(sessionKey: string): Promise<StoredUserRow[]> {
  const entry = await readSessionEntryInWorker({ agentId: AGENT_ID, sessionKey });
  const sessionId = expectDefined(entry?.sessionId, "session id");
  const messages = await readSessionHistoryPageInWorker({
    kind: "recent",
    params: {
      target: {
        agentId: AGENT_ID,
        sessionEntry: { sessionId },
        sessionId,
        sessionKey,
        storePath: resolveSessionStorePathCore(undefined, { agentId: AGENT_ID }),
      },
      maxMessages: 200,
      maxLines: 4020,
      allowResetArchiveFallback: true,
    },
  });
  return messages.filter(
    (message): message is StoredUserRow =>
      typeof message === "object" && message !== null && Reflect.get(message, "role") === "user",
  );
}

/** Run ids the synthetic model decisions were admitted under, in turn order. */
function consumingRunIds() {
  return runEmbeddedAgentMock.mock.calls.map(([params]) => params.runId);
}

/**
 * The RFC's read rule (§2.4): a return is consumed only by a run that a stored input row names
 * beside it; every other state is unknown.
 */
function consumptionOf(rows: readonly StoredUserRow[], deliveryId: string) {
  const runIds = rows.flatMap((row) => {
    const metadata = row["__openclaw"];
    const deliveries = Array.isArray(metadata?.inputDeliveries) ? metadata.inputDeliveries : [];
    return deliveries.some(
      (delivery) => isRecord(delivery) && delivery.deliveryId === deliveryId,
    ) && typeof metadata?.inputRunId === "string"
      ? [metadata.inputRunId]
      : [];
  });
  return runIds.length > 0 ? { state: "consumed", runIds } : { state: "unknown" };
}

it("hands a delegate return to one adopted turn that keeps the chain budget", async ({
  signal,
}) => {
  await withWakeFixture("delegate-return", async ({ sessionKey, sendText, prompts }) => {
    answerTurns(prompts, "Delegate result reviewed.");
    const row = await produceReturn(sessionKey, "delegate alpha finished");
    expect(await rowPending(row)).toBe(true);

    await withinTest(settleContinuationWakesForTest(), signal);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("delegate alpha finished");
    // Adopted, then acknowledged: the durable row settled and nothing is left queued.
    expect(await rowPending(row)).toBe(false);
    expect(
      peekSystemEventEntries(resolveSystemEventQueueKey(sessionKey, AGENT_ID)).map(
        (event) => event.sessionDeliveryAckId,
      ),
    ).toEqual([]);
    // A visible delegate return delivers to the session's route.
    expect(sendText).toHaveBeenCalledOnce();
    // continuationTrigger reached run context: the mid-chain return did not reset the budget.
    const entry = await readSessionEntryInWorker({ agentId: AGENT_ID, sessionKey });
    expect(entry).toMatchObject({
      continuationChainCount: 2,
      continuationChainId: "chain-before-wake",
    });
    // openclaw#1504: the input row names the return, its delegate's run, and the consuming run.
    expect(await readStoredUserRows(sessionKey)).toMatchObject([
      {
        provenance: {
          kind: "internal_system",
          sourceTool: "continuation",
          runId: "child-run:delegate alpha finished",
        },
        __openclaw: {
          inputDeliveries: [{ deliveryId: row, sourceRunId: "child-run:delegate alpha finished" }],
          inputRunId: expectDefined(consumingRunIds()[0], "consuming run"),
        },
      },
    ]);
  });
});

it("keeps silent-wake enrichment transport-silent and mid-chain", async ({ signal }) => {
  await withWakeFixture("silent-wake", async ({ sessionKey, sendText, prompts }) => {
    answerTurns(prompts, "Noted the enrichment.");
    const row = await produceReturn(sessionKey, "enrichment from delegate", {
      wakeRecipients: false,
      returnWake: { reason: "silent-wake-enrichment", parentRunId: "child-silent" },
    });
    requestContinuationWake({
      sessionKey,
      agentId: AGENT_ID,
      reason: "silent-wake-enrichment",
      parentRunId: "child-silent",
      deliveryIds: [row],
    });

    await withinTest(settleContinuationWakesForTest(), signal);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("enrichment from delegate");
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0].terminalReplyExpectation).toBe("optional");
    expect(await rowPending(row)).toBe(false);
    // Recorded in the transcript, never sent to the channel.
    expect(sendText).not.toHaveBeenCalled();
    // A delegate return, not an external subagent-return: the chain budget carries forward.
    expect(await readSessionEntryInWorker({ agentId: AGENT_ID, sessionKey })).toMatchObject({
      continuationChainCount: 2,
      continuationChainId: "chain-before-wake",
    });
  });
});

it("preserves a subagent's owed result on a silent-wake return", async ({ signal }) => {
  await withWakeFixture(
    "silent-subagent",
    async ({ sessionKey, prompts }) => {
      answerTurns(prompts, "Nested result reviewed.");
      const row = await produceReturn(sessionKey, "nested enrichment", {
        wakeRecipients: false,
        returnWake: { reason: "silent-wake-enrichment", parentRunId: "nested-child" },
      });
      requestContinuationWake({
        sessionKey,
        agentId: AGENT_ID,
        reason: "silent-wake-enrichment",
        parentRunId: "nested-child",
        deliveryIds: [row],
      });
      await withinTest(settleContinuationWakesForTest(), signal);
      expect(prompts).toHaveLength(1);
      expect(runEmbeddedAgentMock.mock.calls[0]?.[0].terminalReplyExpectation).toBe(
        "result-required",
      );
    },
    { sessionKey: "agent:main:subagent:silent-nested-parent" },
  );
});

it("coalesces several pending returns into one turn without merging their rows", async ({
  signal,
}) => {
  await withWakeFixture("multiple", async ({ sessionKey, prompts }) => {
    answerTurns(prompts, "Both results reviewed.");
    const first = await produceReturn(sessionKey, "delegate one finished");
    const second = await produceReturn(sessionKey, "delegate two finished");
    const queued = peekSystemEventEntries(resolveSystemEventQueueKey(sessionKey, AGENT_ID));
    expect(queued.map((event) => event.sessionDeliveryAckId)).toEqual([first, second]);

    await withinTest(settleContinuationWakesForTest(), signal);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("delegate one finished");
    expect(prompts[0]).toContain("delegate two finished");
    expect(await rowPending(first)).toBe(false);
    expect(await rowPending(second)).toBe(false);
    // openclaw#1504: the wake's provenance names only the last delegate; each row names its own.
    const rows = await readStoredUserRows(sessionKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["__openclaw"]).toMatchObject({
      inputDeliveries: [
        { deliveryId: first, sourceRunId: "child-run:delegate one finished" },
        { deliveryId: second, sourceRunId: "child-run:delegate two finished" },
      ],
      inputRunId: expectDefined(consumingRunIds()[0], "consuming run"),
    });
  });
});

it("wakes a same-agent subagent session, as a nested delegate's return needs", async ({
  signal,
}) => {
  await withWakeFixture(
    "subagent",
    async ({ sessionKey, prompts }) => {
      answerTurns(prompts, "Nested result reviewed.");
      const row = await produceReturn(sessionKey, "nested delegate finished");

      await withinTest(settleContinuationWakesForTest(), signal);

      // The retired heartbeat runner needed a trusted exception to target a subagent session;
      // the session-event handoff admits it as any session, with the chain budget intact.
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("nested delegate finished");
      expect(await rowPending(row)).toBe(false);
      expect(await readSessionEntryInWorker({ agentId: AGENT_ID, sessionKey })).toMatchObject({
        continuationChainCount: 2,
        continuationChainId: "chain-before-wake",
      });
    },
    { sessionKey: "agent:main:subagent:wake-nested-parent" },
  );
});

it("waits behind a busy session and acknowledges only once its turn is adopted", async ({
  signal,
}) => {
  await withWakeFixture("busy", async ({ sessionKey, prompts }) => {
    const firstTurn = holdFirstTurn(prompts);
    const busy = enqueueSessionEventForHost("unrelated work in progress", {
      agentId: AGENT_ID,
      sessionKey,
      source: "task",
      deliver: false,
    });
    await withinTest(firstTurn.started, signal);
    const row = await produceReturn(sessionKey, "delegate behind busy turn");

    const wakes = settleContinuationWakesForTest();
    await withinTest(handedOff(sessionKey, row), signal);
    // Deferred behind the active run: handed off, not yet adopted, row still pending.
    expect(prompts).toHaveLength(1);
    expect(await rowPending(row)).toBe(true);

    firstTurn.release();
    await withinTest(busy.settled, signal);
    await withinTest(wakes, signal);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("delegate behind busy turn");
    expect(await rowPending(row)).toBe(false);
    // openclaw#1504: the run that executed the deferred return is stamped, not the busy run;
    // an event turn that consumed no return carries no stamp.
    const [busyRunId, wakeRunId] = consumingRunIds();
    expect(wakeRunId).not.toBe(busyRunId);
    const rows = await readStoredUserRows(sessionKey);
    const busyInput = rows.find((input) => input.provenance?.sourceTool === "task");
    expect(busyInput?.["__openclaw"]).not.toHaveProperty("inputRunId");
    expect(rows.find((input) => input.provenance?.sourceTool === "continuation")).toMatchObject({
      __openclaw: {
        inputDeliveries: [{ deliveryId: row, sourceRunId: "child-run:delegate behind busy turn" }],
        inputRunId: expectDefined(wakeRunId, "deferred consuming run"),
      },
    });
  });
});

it("replays a pending return after restart and wakes as its producer would", async ({ signal }) => {
  await withWakeFixture("restart", async ({ sessionKey, prompts }) => {
    answerTurns(prompts, "Recovered result reviewed.");
    const row = await produceReturn(sessionKey, "delegate before restart");
    // The process dies before the wake runs: the in-memory event and wake are gone, the row stays.
    resetContinuationWakesForTest();
    resetSystemEventsForTest();
    expect(await rowPending(row)).toBe(true);

    await recoverPendingProducedSessionDeliveries({
      deps: {},
      queueContext: captureOpenClawStateWorkerContext(),
    });
    await withinTest(settleContinuationWakesForTest(), signal);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("delegate before restart");
    expect(await rowPending(row)).toBe(false);
    expect(await readSessionEntryInWorker({ agentId: AGENT_ID, sessionKey })).toMatchObject({
      continuationChainCount: 2,
    });
    // openclaw#1504: the replay keeps the row's delegate run; the post-recovery run is stamped.
    expect(await readStoredUserRows(sessionKey)).toMatchObject([
      {
        __openclaw: {
          inputDeliveries: [{ deliveryId: row, sourceRunId: "child-run:delegate before restart" }],
          inputRunId: expectDefined(consumingRunIds()[0], "consuming run"),
        },
      },
    ]);
  });
});

it("leaves a return for a missing target queued and its row pending", async ({ signal }) => {
  await withWakeFixture(
    "missing-target",
    async ({ sessionKey, prompts }) => {
      answerTurns(prompts, "unreachable");
      const row = await produceReturn(sessionKey, "delegate for a missing session");

      await withinTest(settleContinuationWakesForTest(), signal);

      // The handoff refuses an absent origin: no turn, no ack, and the occurrence is
      // passive again so a later turn or replay still owns it.
      expect(prompts).toEqual([]);
      expect(await rowPending(row)).toBe(true);
      const queueKey = resolveSystemEventQueueKey(sessionKey, AGENT_ID);
      const queued = peekSystemEventEntries(queueKey);
      expect(queued.map((event) => event.sessionDeliveryAckId)).toEqual([row]);
      expect(queued.some((event) => isSystemEventTurnOwned(queueKey, event))).toBe(false);
    },
    { session: false },
  );
});

it("refuses a return whose recipient authority an owner change advanced", async ({ signal }) => {
  await withWakeFixture("stale-authority", async ({ sessionKey, prompts }) => {
    answerTurns(prompts, "unreachable");
    const scope = { agentId: AGENT_ID, sessionKey };
    const recipientAuthority = await captureSessionRecipientAuthority(scope);
    const row = await produceReturn(sessionKey, "delegate for the old owner", {
      recipientAuthorities: new Map([[sessionKey, recipientAuthority]]),
    });
    // The session changes hands before the wake runs.
    assignSessionOwner(scope, {
      owner: { type: "human", id: "new-owner" },
      assignedBy: { type: "human", id: "operator" },
    });

    await withinTest(settleContinuationWakesForTest(), signal);

    expect(prompts).toEqual([]);
    // Refused, never delivered or acked: the row settles and the event leaves the queue.
    expect(await rowPending(row)).toBe(false);
    expect(ackedRows.has(row)).toBe(false);
    expect(warnings).toContain(
      `[continuation:return-refused] stage=wake reason=recipient-authority-changed session=${sessionKey} deliveryId=${row}`,
    );
    expect(peekSystemEventEntries(resolveSystemEventQueueKey(sessionKey, AGENT_ID))).toEqual([]);
  });
});

it("releases a refused current return at once when a stale return's settlement fails", async ({
  signal,
}) => {
  await withWakeFixture("stale-settlement-failure", async ({ sessionKey, prompts }) => {
    answerTurns(prompts, "unreachable");
    const scope = { agentId: AGENT_ID, sessionKey };
    const recipientAuthority = await captureSessionRecipientAuthority(scope);
    const stale = await produceReturn(sessionKey, "delegate for the deleted session", {
      wakeRecipients: false,
      recipientAuthorities: new Map([[sessionKey, recipientAuthority]]),
    });
    // Deletion advances the recipient authority, and leaves no origin for a later return's turn.
    const deletion = await deleteSessionEntryLifecycle({
      agentId: AGENT_ID,
      archiveTranscript: false,
      storePath: resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID }),
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    expect(deletion.deleted).toBe(true);
    const current = await produceReturn(sessionKey, "unbound delegate return", {
      wakeRecipients: false,
    });
    const queueKey = resolveSystemEventQueueKey(sessionKey, AGENT_ID);
    const queued = peekSystemEventEntries(queueKey);
    expect(queued.map((event) => event.sessionDeliveryAckId)).toEqual([stale, current]);
    const stateDir = queued[1]?.sessionDeliveryAckStateDir;
    failingAcks.add(stale);
    requestContinuationWake({
      sessionKey,
      agentId: AGENT_ID,
      reason: "delegate-return",
      deliveryIds: [stale, current],
    });

    await withinTest(settleContinuationWakesForTest(), signal);

    // The current return's handoff was refused; its claim is released now, not at lease
    // expiry, so a later turn or replay can take it. The stale row stays for replay.
    expect(prompts).toEqual([]);
    expect(isDeliveryAdoptionClaimed(current, stateDir)).toBe(false);
    expect(
      peekSystemEventEntries(queueKey).some((event) => isSystemEventTurnOwned(queueKey, event)),
    ).toBe(false);
    expect(await rowPending(current)).toBe(true);
    expect(await rowPending(stale)).toBe(true);
  });
});

it("adopts and acknowledges a return whose turn ends in an intentional silent reply", async ({
  signal,
}) => {
  await withWakeFixture("silent-terminal", async ({ sessionKey, sendText, prompts }) => {
    answerTurns(prompts, "NO_REPLY");
    const row = await produceReturn(sessionKey, "delegate with nothing to say");

    await withinTest(settleContinuationWakesForTest(), signal);

    expect(prompts).toHaveLength(1);
    expect(sendText).not.toHaveBeenCalled();
    expect(await rowPending(row)).toBe(false);
  });
});

it("emits the queue drain for the returns it hands off, parented by their traceparent", async ({
  signal,
}) => {
  await withWakeFixture("traced", async ({ sessionKey, prompts }) => {
    answerTurns(prompts, "Traced result reviewed.");
    const spans: Array<{ name: string } & StartSpanOptions> = [];
    setContinuationTracer({
      startSpan(name, options) {
        spans.push({ name, ...options });
        return { setAttributes() {}, setStatus() {}, recordException() {}, end() {} };
      },
    });
    try {
      const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
      await produceReturn(sessionKey, "[continuation:enrichment-return] traced delegate", {
        traceparent,
      });

      await withinTest(settleContinuationWakesForTest(), signal);

      expect(prompts).toHaveLength(1);
      // The woken turn drains no passive events, so this is the return's only drain span.
      expect(
        spans.filter(
          (span) => span.name === "continuation.queue.drain" && span.traceparent === traceparent,
        ),
      ).toEqual([
        {
          name: "continuation.queue.drain",
          traceparent,
          attributes: {
            "queue.drained_count": 1,
            "queue.drained_continuation_count": 1,
          },
        },
      ]);
    } finally {
      resetContinuationTracer();
    }
  });
});

// openclaw#1504: a user-authored row is never a delegate consumption, and the stamp is best-effort.
it("never stamps a user-authored turn that adopts a queued return as a delegate consumption", async ({
  signal,
}) => {
  await withWakeFixture("consuming-run-user", async ({ sessionKey, prompts }) => {
    answerTurns(prompts, "Answered the operator.");
    const row = await produceReturn(sessionKey, "delegate before the operator asked", {
      wakeRecipients: false,
    });

    await withinTest(getReplyFromConfig(operatorMessage(sessionKey)), signal);

    // The operator's turn adopted the return: it carries the receipt, but no consumption stamp.
    expect(await rowPending(row)).toBe(false);
    const rows = await readStoredUserRows(sessionKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["__openclaw"]).toMatchObject({ sessionDeliveryAckIds: [row] });
    expect(rows[0]?.["__openclaw"]).not.toHaveProperty("inputRunId");
    expect(rows[0]?.["__openclaw"]).not.toHaveProperty("inputDeliveries");
  });
});

it("keeps a woken turn and its return when the consuming-run stamp fails to write", async ({
  signal,
}) => {
  await withWakeFixture(
    "consuming-run-stamp-failure",
    async ({ sessionKey, sendText, prompts }) => {
      answerTurns(prompts, "Delegate result reviewed.");
      const row = await produceReturn(sessionKey, "delegate with a lost stamp");
      failingStamp.armed = true;

      await withinTest(settleContinuationWakesForTest(), signal);

      // The stamp is best-effort: the turn answers and the return settles without it.
      expect(prompts).toHaveLength(1);
      expect(sendText).toHaveBeenCalledOnce();
      expect(await rowPending(row)).toBe(false);
      const [input] = await readStoredUserRows(sessionKey);
      expect(input?.["__openclaw"]).toMatchObject({
        inputDeliveries: [{ deliveryId: row, sourceRunId: "child-run:delegate with a lost stamp" }],
      });
      expect(input?.["__openclaw"]).not.toHaveProperty("inputRunId");
    },
  );
});

it("maps each coalesced return to the run that adopted it, not a run it queued behind", async ({
  signal,
}) => {
  await withWakeFixture("consumed-coalesced", async ({ sessionKey, prompts }) => {
    const firstTurn = holdFirstTurn(prompts);
    const first = await produceReturn(sessionKey, "delegate one finished");
    const second = await produceReturn(sessionKey, "delegate two finished");
    const coalescedWake = settleContinuationWakesForTest();
    await withinTest(firstTurn.started, signal);
    // A third return lands while the coalesced turn runs; its own wake queues behind that turn.
    const third = await produceReturn(sessionKey, "delegate three finished");
    const laterWake = settleContinuationWakesForTest();
    await withinTest(handedOff(sessionKey, third), signal);
    firstTurn.release();
    await withinTest(Promise.all([coalescedWake, laterWake]), signal);

    // Each credited run's model input carried exactly the returns it is credited with.
    const [coalescedRun, laterRun] = consumingRunIds();
    expect(laterRun).not.toBe(coalescedRun);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("delegate two finished");
    expect(prompts[0]).not.toContain("delegate three finished");
    expect(prompts[1]).toContain("delegate three finished");
    expect(prompts[1]).not.toContain("delegate one finished");
    const rows = await readStoredUserRows(sessionKey);
    expect([first, second, third].map((id) => consumptionOf(rows, id))).toEqual([
      { state: "consumed", runIds: [coalescedRun] },
      { state: "consumed", runIds: [coalescedRun] },
      { state: "consumed", runIds: [laterRun] },
    ]);
  });
});

it("never reports a retired return as consumed by the turn its wake still ran", async ({
  signal,
}) => {
  await withWakeFixture("consumed-retired", async ({ sessionKey, prompts }) => {
    answerTurns(prompts, "Current result reviewed.");
    const scope = { agentId: AGENT_ID, sessionKey };
    const retired = await produceReturn(sessionKey, "delegate for the old owner", {
      recipientAuthorities: new Map([[sessionKey, await captureSessionRecipientAuthority(scope)]]),
    });
    assignSessionOwner(scope, {
      owner: { type: "human", id: "new-owner" },
      assignedBy: { type: "human", id: "operator" },
    });
    const current = await produceReturn(sessionKey, "delegate for the current owner", {
      recipientAuthorities: new Map([[sessionKey, await captureSessionRecipientAuthority(scope)]]),
    });

    await withinTest(settleContinuationWakesForTest(), signal);

    // One coalesced wake: the retired row settles undelivered, the current one is adopted.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("delegate for the current owner");
    expect(prompts[0]).not.toContain("delegate for the old owner");
    expect(await rowPending(retired)).toBe(false);
    const rows = await readStoredUserRows(sessionKey);
    expect(consumptionOf(rows, retired)).toEqual({ state: "unknown" });
    expect(consumptionOf(rows, current)).toEqual({
      state: "consumed",
      runIds: [consumingRunIds()[0]],
    });
  });
});

it("reports a return adopted without a durable receipt as unknown, though its model saw it", async ({
  signal,
}) => {
  await withWakeFixture("consumed-no-receipt", async ({ sessionKey, prompts }) => {
    answerTurns(prompts, "Answered the operator.");
    const row = await produceReturn(sessionKey, "delegate the operator's turn picked up", {
      wakeRecipients: false,
    });
    // The operator's input is durable before its turn drains the return, so its recorder cannot
    // carry the return's id (session-system-event-adoption.ts: adoptedWithoutReceipt).
    const sessionEntry = expectDefined(
      await readSessionEntryInWorker({ agentId: AGENT_ID, sessionKey }),
      "session entry",
    );
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "what did the delegate find?", timestamp: Date.now() },
      target: {
        agentId: AGENT_ID,
        sessionKey,
        sessionId: sessionEntry.sessionId,
        sessionEntry,
        storePath: resolveSessionStorePathCore(undefined, { agentId: AGENT_ID }),
      },
    });
    await recorder.persistApproved();

    await withinTest(
      getReplyFromConfig(operatorMessage(sessionKey), { userTurnTranscriptRecorder: recorder }),
      signal,
    );

    // Adopted and acknowledged, and the model saw it, yet no durable row names it: unknown.
    expect(prompts).toHaveLength(1);
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0].currentInboundContext?.text).toContain(
      "delegate the operator's turn picked up",
    );
    expect(await rowPending(row)).toBe(false);
    const rows = await readStoredUserRows(sessionKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["__openclaw"]).not.toHaveProperty("sessionDeliveryAckIds");
    expect(consumptionOf(rows, row)).toEqual({ state: "unknown" });
  });
});

it.for([
  { dispatched: false, crashed: "after committing its input, before provider dispatch" },
  { dispatched: true, crashed: "after provider dispatch" },
])(
  "keeps a crashed run's evidence its own when a replay adopts the return again ($crashed)",
  async ({ dispatched }, { signal }) => {
    await withWakeFixture(`consumed-replay-${dispatched}`, async ({ sessionKey, prompts }) => {
      const row = await produceReturn(sessionKey, "delegate before the crash");
      // The crashed run adopts the return, but its queue ack never lands.
      failingAcks.add(row);
      runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
        prompts.push(params.prompt);
        await (dispatched ? admitWokenTurn(params) : admitModelTurn(params));
        throw new Error("synthetic process death");
      });
      await withinTest(settleContinuationWakesForTest(), signal);
      const crashedRun = expectDefined(consumingRunIds()[0], "crashed run");
      // The process dies: queued events and wakes are gone, the unacknowledged row stays.
      resetContinuationWakesForTest();
      resetSystemEventsForTest();
      failingAcks.clear();
      expect(await rowPending(row)).toBe(true);
      expect(consumptionOf(await readStoredUserRows(sessionKey), row)).toEqual(
        dispatched ? { state: "consumed", runIds: [crashedRun] } : { state: "unknown" },
      );

      answerTurns(prompts, "Recovered result reviewed.");
      await recoverPendingProducedSessionDeliveries({
        deps: {},
        queueContext: captureOpenClawStateWorkerContext(),
      });
      await withinTest(settleContinuationWakesForTest(), signal);

      // Recovering the row never moves the crashed run's evidence; the replay records its own.
      const replayRun = expectDefined(consumingRunIds()[1], "replay run");
      expect(replayRun).not.toBe(crashedRun);
      expect(prompts[1]).toContain("delegate before the crash");
      expect(await rowPending(row)).toBe(false);
      const rows = await readStoredUserRows(sessionKey);
      expect(rows.map((input) => input["__openclaw"]?.inputRunId)).toEqual([
        dispatched ? crashedRun : undefined,
        replayRun,
      ]);
      expect(consumptionOf(rows, row)).toEqual({
        state: "consumed",
        runIds: dispatched ? [crashedRun, replayRun] : [replayRun],
      });
    });
  },
);

// Continuation (karmaterminal): proves a reply turn acks a managed (durable-ack) return only after its user turn commits the receipt, and restores or replays it, never double-delivers, when the turn fails around that commit.
import { describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore, type SessionEntry } from "../../config/sessions.js";
import {
  assignSessionOwner,
  captureSessionRecipientAuthority,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { deliverQueuedSessionDelivery } from "../../gateway/server-restart-sentinel.js";
import {
  ackSessionDelivery,
  loadPendingSessionDeliveries,
} from "../../infra/session-delivery-queue-storage.js";
import { isDeliveryAdoptionClaimed } from "../../infra/system-event-delivery-claims.js";
import { enqueueSystemEvent, peekSystemEventEntries } from "../../infra/system-events.js";
import { resolveProviderReasoningOutputModeWithPlugin } from "../../plugins/provider-replay-runtime.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { useContinuationCustodyTestState } from "../continuation/custody/custody.test-support.js";
import { captureContinuationQueueContext } from "../continuation/queue-context.js";
import { enqueueContinuationReturnDeliveries } from "../continuation/targeting.js";
import type { runReplyAgent } from "./agent-runner-run.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { executePreparedReplyRun } from "./get-reply-run-execute.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { admitFollowupRunLifecycle } from "./queue/lifecycle.js";
import { readAdoptedSystemEventDeliveryIds } from "./session-system-event-adoption.js";
import { createTypingController } from "./typing.js";

type RunReplyAgentParams = Parameters<typeof runReplyAgent>[0];
type RunnerScript = (run: RunReplyAgentParams) => Promise<{ text: string } | undefined>;
const runner = vi.hoisted(() => ({
  script: undefined as undefined | ((run: never) => Promise<{ text: string } | undefined>),
  calls: [] as unknown[],
  steps: [] as string[],
}));

vi.mock("../../agents/auth-profiles/session-override.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/session-override.js")>()),
  resolveSessionAuthSelection: vi.fn(async () => undefined),
}));
// The agent runner (model loop) is the edge; each case scripts what it commits and adopts.
vi.mock("./get-reply-run-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./get-reply-run-helpers.js")>()),
  loadAgentRunnerRuntime: async () => ({
    runReplyAgent: async (run: never) => {
      runner.calls.push(run);
      return await runner.script?.(run);
    },
  }),
  loadEmbeddedAgentRuntime: async () => ({
    preemptAndDrainEmbeddedHeartbeatRun: async () => "not-heartbeat",
    resolveActiveEmbeddedRunBySessionFile: () => undefined,
  }),
  loadSessionUpdatesRuntime: async () => ({
    ensureSkillSnapshot: async ({ sessionEntry }: { sessionEntry: SessionEntry }) => ({
      sessionEntry,
    }),
  }),
}));
// Pass-through: the real ack and refusal run; their order against commits is recorded.
vi.mock("../../infra/session-delivery-queue-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/session-delivery-queue-storage.js")>();
  return {
    ...actual,
    ackSessionDelivery: vi.fn(async (...args: Parameters<typeof actual.ackSessionDelivery>) => {
      runner.steps.push(`ack:${args[0]}`);
      return await actual.ackSessionDelivery(...args);
    }),
    moveSessionDeliveryToFailed: async (
      ...args: Parameters<typeof actual.moveSessionDeliveryToFailed>
    ) => {
      runner.steps.push(`retire:${args[0]}`);
      return await actual.moveSessionDeliveryToFailed(...args);
    },
  };
});
// Provider plugin edge: a case makes the reasoning-mode hook throw once.
vi.mock("../../plugins/provider-replay-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/provider-replay-runtime.js")>();
  return {
    ...actual,
    resolveProviderReasoningOutputModeWithPlugin: vi.fn(
      actual.resolveProviderReasoningOutputModeWithPlugin,
    ),
  };
});
// mock-isolation: A replayed return may request a continuation wake; record it, run nothing.
vi.mock("../continuation/continuation-wake.js", () => ({
  requestContinuationWake: vi.fn(),
}));

const SESSION_KEY = "agent:main:managed-proof";
const SESSION_ID = "managed-proof-session";
const custody = useContinuationCustodyTestState();

// The default agent store under the custody state dir, as production resolves it.
const storePath = () => resolveSessionStorePathCore(undefined, { agentId: "main" });
const queueContext = () => captureContinuationQueueContext(custody.stateDir());

async function seedSession(): Promise<SessionEntry> {
  const entry = { sessionKey: SESSION_KEY, sessionId: SESSION_ID, updatedAt: Date.now() };
  await replaceSessionEntry({ storePath: storePath(), sessionKey: SESSION_KEY }, entry as never);
  return entry;
}

async function admitReturn(
  id: string,
  recipientAuthorities?: Parameters<
    typeof enqueueContinuationReturnDeliveries
  >[0]["recipientAuthorities"],
): Promise<string> {
  const result = await enqueueContinuationReturnDeliveries({
    targetSessionKeys: [SESSION_KEY],
    ...(recipientAuthorities ? { recipientAuthorities } : {}),
    text: `RETURN-${id}`,
    idempotencyKeyBase: `continuation-return:${id}`,
    childRunId: `run-${id}`,
    stateDir: custody.stateDir(),
    ownerAgentId: "main",
  });
  expect(result.delivered).toBe(1);
  return result.deliveryIds[0]!;
}

async function runTurn(
  entry: SessionEntry,
  script: RunnerScript,
  options: { abort?: AbortController; beforeExecute?: () => void } = {},
) {
  const { abort } = options;
  runner.script = script as never;
  const body = "continue";
  const ctx = finalizeInboundContext({
    SessionKey: SESSION_KEY,
    Provider: "slack",
    ChatType: "channel",
    Body: body,
    RawBody: body,
    CommandBody: body,
    BodyStripped: body,
  });
  const cfg = {};
  const context = await prepareReplyRunContext({
    ctx,
    sessionCtx: ctx,
    conversation: prepareReplyConversation({ ctx, sessionEntry: entry }),
    sessionEntry: entry,
    cfg,
    agentId: "main",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      surface: "slack",
      channel: "slack",
      ownerList: [],
      senderIsOwner: false,
      isAuthorizedSender: true,
      rawBodyNormalized: body,
      commandBodyNormalized: body,
    },
    allowTextCommands: true,
    directives: parseInlineSessionDirectives(body),
    defaultActivation: "always",
    modelState: createModelSelectionStateFixture({
      agentCfg: {},
      provider: "anthropic",
      model: "claude",
    }),
    provider: "anthropic",
    model: "claude",
    typing: createTypingController({}),
    defaultModel: "claude",
    timeoutMs: 30_000,
    isNewSession: false,
    resetTriggered: false,
    systemSent: true,
    sessionKey: SESSION_KEY,
    sessionId: SESSION_ID,
    storePath: storePath(),
    sessionStore: { [SESSION_KEY]: entry },
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
    resolvedThinkLevel: "off",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    ...(abort ? { opts: { abortSignal: abort.signal } } : {}),
  });
  if (context.kind !== "ready") {
    throw new Error("Expected a prepared reply context");
  }
  const admission = await prepareReplyRunAdmission(context);
  if (admission.kind !== "ready") {
    throw new Error("Expected a ready reply admission");
  }
  options.beforeExecute?.();
  return await executePreparedReplyRun(admission, () => cfg);
}

/** What the runtime does for a run-now turn: commit the user turn, then adopt it. */
async function commit(run: RunReplyAgentParams) {
  await run.followupRun.userTurnTranscriptRecorder?.persistApproved();
  runner.steps.push("commit");
}
async function adopt(run: RunReplyAgentParams) {
  await admitFollowupRunLifecycle(run.followupRun);
  runner.steps.push("adopted");
}
const commitAndAdopt: RunnerScript = async (run) => {
  await commit(run);
  await adopt(run);
  return { text: "ok" };
};

function lastPrompt(): string {
  const run = runner.calls.at(-1) as RunReplyAgentParams | undefined;
  return run?.followupRun.currentInboundContext?.text ?? "";
}

async function snapshot(id: string) {
  const transcript = await loadTranscriptEvents({
    agentId: "main",
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    storePath: storePath(),
  });
  return {
    pending: (await loadPendingSessionDeliveries(queueContext())).map((row) => row.id),
    queued: peekSystemEventEntries(SESSION_KEY).map((event) => event.sessionDeliveryAckId),
    committedReceipt: readAdoptedSystemEventDeliveryIds(transcript).has(id),
    acks: vi.mocked(ackSessionDelivery).mock.calls.filter(([ackId]) => ackId === id).length,
  };
}

/** Past the adoption-claim lease, the real replay executor re-queues the pending row. */
async function replayAfterClaimLease(id: string) {
  const realNow = Date.now();
  const wallClock = vi.spyOn(Date, "now").mockReturnValue(realNow + 11 * 60_000);
  try {
    expect(isDeliveryAdoptionClaimed(id, custody.stateDir())).toBe(false);
    const [row] = await loadPendingSessionDeliveries(queueContext());
    await expect(
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: row!,
        queueContext: captureOpenClawStateWorkerContext({
          env: { ...process.env, OPENCLAW_STATE_DIR: custody.stateDir() },
        }),
      }),
    ).rejects.toThrow("system event is awaiting durable prompt adoption");
  } finally {
    wallClock.mockRestore();
  }
  expect(peekSystemEventEntries(SESSION_KEY).map((event) => event.sessionDeliveryAckId)).toEqual([
    id,
  ]);
}

async function expectDeliveredOnceAndSettled(entry: SessionEntry, id: string, text: string) {
  resetRunner();
  await runTurn(entry, commitAndAdopt);
  expect(lastPrompt().split(text).length - 1).toBe(1);
  expect(await snapshot(id)).toEqual({
    pending: [],
    queued: [],
    committedReceipt: true,
    acks: 1,
  });
}

function resetRunner() {
  runner.calls.length = 0;
  runner.steps.length = 0;
  vi.mocked(ackSessionDelivery).mockClear();
}

describe("managed delivery ack follows the committed user turn", () => {
  it("acks a managed return only after the turn that carried it commits its receipt", async () => {
    const entry = await seedSession();
    const id = await admitReturn("committed");
    resetRunner();

    await runTurn(entry, commitAndAdopt);

    expect(lastPrompt().split("RETURN-committed").length - 1).toBe(1);
    expect(runner.steps).toEqual(["commit", `ack:${id}`, "adopted"]);
    expect(await snapshot(id)).toEqual({
      pending: [],
      queued: [],
      committedReceipt: true,
      acks: 1,
    });
  });

  it.each(["fails", "aborts"] as const)(
    "never acks a managed return when its turn %s before the commit, and puts it back once",
    async (failure) => {
      const entry = await seedSession();
      const id = await admitReturn(`before-commit-${failure}`);
      resetRunner();
      const abort = new AbortController();

      const outcome = await runTurn(
        entry,
        async () => {
          if (failure === "aborts") {
            abort.abort(new Error("turn aborted before commit"));
            abort.signal.throwIfAborted();
          }
          throw new Error("model call failed before commit");
        },
        { abort },
      ).catch((error: unknown) => (error as Error).message);

      expect(outcome).toBe(
        failure === "aborts" ? "turn aborted before commit" : "model call failed before commit",
      );
      expect(lastPrompt()).toContain(`RETURN-before-commit-${failure}`);
      expect(runner.steps).toEqual([]);
      expect(await snapshot(id)).toEqual({
        pending: [id],
        queued: [id],
        committedReceipt: false,
        acks: 0,
      });
      expect(isDeliveryAdoptionClaimed(id, custody.stateDir())).toBe(false);

      // The restored return reaches the next turn exactly once and settles there.
      resetRunner();
      await runTurn(entry, commitAndAdopt);
      expect(lastPrompt().split(`RETURN-before-commit-${failure}`).length - 1).toBe(1);
      expect(runner.steps).toEqual(["commit", `ack:${id}`, "adopted"]);
      expect(await snapshot(id)).toEqual({
        pending: [],
        queued: [],
        committedReceipt: true,
        acks: 1,
      });
    },
  );

  it("settles from the transcript, without re-delivery, when the turn fails between commit and adoption", async () => {
    const entry = await seedSession();
    const id = await admitReturn("between");
    resetRunner();

    const outcome = await runTurn(entry, async (run) => {
      await commit(run);
      throw new Error("runner failed after commit");
    }).catch((error: unknown) => (error as Error).message);

    expect(outcome).toBe("runner failed after commit");
    expect(runner.steps).toEqual(["commit"]);
    expect(await snapshot(id)).toEqual({
      pending: [id],
      queued: [id],
      committedReceipt: true,
      acks: 0,
    });

    // The next turn finds the committed receipt: it acks the row and keeps the
    // return out of its prompt instead of delivering it a second time.
    resetRunner();
    await runTurn(entry, commitAndAdopt);
    expect(lastPrompt()).not.toContain("RETURN-between");
    expect(runner.steps[0]).toBe(`ack:${id}`);
    expect(await snapshot(id)).toEqual({
      pending: [],
      queued: [],
      committedReceipt: true,
      acks: 1,
    });
  });

  it("never acks an adoption without a committed receipt; the row replays once the claim lapses", async () => {
    const entry = await seedSession();
    const id = await admitReturn("no-receipt");
    resetRunner();

    await runTurn(entry, async (run) => {
      await adopt(run);
      return { text: "ok" };
    });

    expect(runner.steps).toEqual(["adopted"]);
    expect(await snapshot(id)).toEqual({
      pending: [id],
      queued: [],
      committedReceipt: false,
      acks: 0,
    });
    // The adopting turn's claim keeps a replay off the row until the lease lapses.
    expect(isDeliveryAdoptionClaimed(id, custody.stateDir())).toBe(true);
    await replayAfterClaimLease(id);
    await expectDeliveredOnceAndSettled(entry, id, "RETURN-no-receipt");
  });

  it("lets the row replay when the turn throws after promotion, before its run starts", async () => {
    const entry = await seedSession();
    const id = await admitReturn("pre-run");
    resetRunner();
    // A provider plugin hook that throws while the queued run is being assembled.
    vi.mocked(resolveProviderReasoningOutputModeWithPlugin).mockImplementationOnce(() => {
      throw new Error("provider plugin reasoning hook failed");
    });

    const outcome = await runTurn(entry, commitAndAdopt).catch(
      (error: unknown) => (error as Error).message,
    );

    expect(outcome).toBe("provider plugin reasoning hook failed");
    expect(runner.calls).toEqual([]);
    // Promotion consumed the return; nothing committed, adopted or acked it.
    expect(await snapshot(id)).toEqual({
      pending: [id],
      queued: [],
      committedReceipt: false,
      acks: 0,
    });
    // No turn is in flight, so its claim must lapse with the lease.
    await replayAfterClaimLease(id);
    await expectDeliveredOnceAndSettled(entry, id, "RETURN-pre-run");
  });

  it("refuses a return whose recipient owner changes between admission and promotion", async () => {
    const ownerA = { type: "human" as const, source: "unknown" as const, id: "owner-a" };
    const entry = { ...(await seedSession()), createdActor: ownerA, visibility: "shared" as const };
    await replaceSessionEntry({ storePath: storePath(), sessionKey: SESSION_KEY }, entry as never);
    const scope = { agentId: "main", storePath: storePath(), sessionKey: SESSION_KEY };
    const authority = await captureSessionRecipientAuthority(scope);
    const id = await admitReturn("stale-owner", new Map([[SESSION_KEY, authority]]));
    enqueueSystemEvent("UNBOUND-SIBLING", { sessionKey: SESSION_KEY });
    resetRunner();

    await runTurn(entry, commitAndAdopt, {
      beforeExecute: () => {
        expect(
          assignSessionOwner(scope, {
            owner: { type: "human", id: "owner-b" },
            assignedBy: ownerA,
            assignedAt: 3,
          }),
        ).not.toBeNull();
      },
    });

    // The new owner's turn gets the unbound sibling, never the stale return; the
    // row is refused (retired unacked), not restored and not adopted.
    expect(lastPrompt()).toContain("UNBOUND-SIBLING");
    expect(lastPrompt()).not.toContain("RETURN-stale-owner");
    expect(runner.steps).toEqual([`retire:${id}`, "commit", "adopted"]);
    expect(await snapshot(id)).toEqual({
      pending: [],
      queued: [],
      committedReceipt: false,
      acks: 0,
    });
  });
});

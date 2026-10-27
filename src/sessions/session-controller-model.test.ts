import { describe, expect, it, vi } from "vitest";
import { QuestionAnswerUnconfirmedError } from "../agents/harness/gateway-question-dispatch.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../agents/run-termination.js";
import { retryRestartRecoveryBeforeSelectedClaim } from "../auto-reply/reply/reply-turn-recovery-predecessor.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { applyQueueDropPolicy } from "../utils/queue-helpers.js";
import {
  generatePilotSequence,
  initialPilotState,
  modelParentMailbox,
  stepPilot,
  stepPilotMailbox,
  type PilotCustody,
  type PilotEvent,
  type PilotInput,
  type PilotMailbox,
  type PilotParentInput,
} from "./session-controller-model.test-support.js";
import type { ReplyMessageInjectionAttempt } from "./session-controller.contracts.js";
import { createReplyOperation, getSessionControllerOperation } from "./session-controller.js";
import {
  beginSessionEffect,
  startSessionControllerInterruption,
} from "./session-controller.lifecycle.js";
import {
  clearSessionControllerMailbox,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
  type SessionControllerInput,
  type SessionControllerMailboxClaim,
} from "./session-controller.mailbox.js";
import {
  beginReplyMessageInjectionTarget,
  captureCurrentReplyMessageInjectionTarget,
} from "./session-controller.message-injection.js";

type Receipt = PilotEvent & { type: "receipt" };
const deliverySettlement = [{ type: "complete" }, { type: "delivery-settled" }] as const;

function reserve(
  key: string,
  options: Partial<Parameters<typeof reserveSessionControllerSource>[1]> = {},
) {
  return reserveSessionControllerSource(key, { policy: { mode: "followup" }, ...options });
}

function release(claim: SessionControllerMailboxClaim) {
  releaseSessionControllerClaim(claim);
  return claim.settlement.promise;
}

function operationFor(sessionKey: string, sessionId = "pilot-session") {
  return createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
}

function recordClaim(source: SessionControllerInput, turns: string[], id = source.sourceTurnId!) {
  return claimSessionControllerTask(source, () => {
    turns.push(id);
  });
}

/** Calls public owner operations, never the runtime reducer under test. */
async function replay(events: readonly PilotEvent[], label: string) {
  let model = initialPilotState();
  let live = true;
  const sourceRevoked = new Error("source revoked");
  let compacting = false;
  let injectionAvailable = true;
  let writer = true;
  const key = "agent:main:controller-pilot";
  const gates = new Map<string, ReturnType<typeof createDeferredCore<Receipt>>>();
  const attempts = new Map<string, ReplyMessageInjectionAttempt>();
  const custody = new Map<string, PilotCustody>();
  const effects: string[] = [];
  const deliveries: ReturnType<typeof createDeferredCore<void>>[] = [];
  const operations: ReturnType<typeof createReplyOperation>[] = [];
  const create = () => {
    const operation = operationFor(key);
    const delivery = createDeferredCore();
    deliveries.push(delivery);
    operations.push(operation);
    void operation.ownerSettlement?.then(() => {
      if (current.operation === operation) {
        writer = false;
      }
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "pilot-run",
      toolAuthorityFingerprint: "alice-policy",
      cancel: () => {
        effects.push("cancel");
      },
      isCompacting: () => compacting,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => injectionAvailable,
        async queueMessage(_text, options, assertCurrent) {
          const id = options?.queueIdentity;
          if (!id) {
            throw new Error("Missing input identity");
          }
          effects.push("inject:" + id);
          const gate = createDeferredCore<Receipt>();
          gates.set(id, gate);
          const receipt = await gate.promise;
          assertCurrent();
          if (receipt.outcome === "indeterminate") {
            throw new QuestionAnswerUnconfirmedError("unknown acceptance");
          }
          if (receipt.outcome === "rejected") {
            throw new Error("backend rejected");
          }
          options?.onQueueAccepted?.(true);
        },
      },
    });
    return { operation, delivery };
  };
  let current = create();
  const prefix: PilotEvent[] = [];
  try {
    for (const event of events) {
      prefix.push(event);
      const expected = stepPilot(model, event);
      const beforeEffects = effects.length;
      switch (event.type) {
        case "run":
          current.operation.setPhase("running");
          break;
        case "finish":
          current.operation.freezeAbort();
          break;
        case "stop":
          current.operation.abortByUser();
          break;
        case "injection-available":
          injectionAvailable = event.available;
          break;
        case "compact":
          compacting = event.active;
          break;
        case "revoke":
          live = false;
          break;
        case "complete":
          current.operation.completeWithAfterClearBarrier(current.delivery.promise);
          break;
        case "delivery-settled":
          current.delivery.resolve();
          await current.operation.ownerSettlement;
          break;
        case "replace":
          current = create();
          live = true;
          compacting = false;
          injectionAvailable = true;
          writer = true;
          break;
        case "offer": {
          const target = captureCurrentReplyMessageInjectionTarget(key);
          if (!target) {
            custody.set(event.input.id, "rejected");
            break;
          }
          const attempt = await beginReplyMessageInjectionTarget(target, event.input.id, {
            queueIdentity: event.input.id,
            isInboundUserMessage: true,
            toolAuthorityFingerprint: event.input.authority,
            assertCurrent: () => {
              if (!live) {
                throw sourceRevoked;
              }
            },
          }).catch((error: unknown) => {
            if (error !== sourceRevoked) {
              throw error;
            }
            return undefined;
          });
          if (!attempt) {
            custody.set(event.input.id, "failed");
            break;
          }
          attempts.set(event.input.id, attempt);
          custody.set(
            event.input.id,
            gates.has(event.input.id) ? "offered" : (await attempt.outcome).status,
          );
          break;
        }
        case "receipt": {
          const gate = gates.get(event.id);
          const attempt = attempts.get(event.id);
          if (!gate || !attempt) {
            break;
          }
          gate.resolve(event);
          const outcome = await attempt.outcome;
          custody.set(event.id, outcome.status);
          if (outcome.status === "accepted" || outcome.status === "indeterminate") {
            expect(await attempt.acceptance).toBe(true);
          }
          gates.delete(event.id);
          break;
        }
      }
      await Promise.resolve();
      model = expected.state;
      const context = label + " prefix=" + JSON.stringify(prefix);
      expect(getSessionControllerOperation(key) === current.operation, context).toBe(model.slot);
      expect(current.operation.abortSignal.aborted, context).toBe(model.cancelled);
      expect(writer, context).toBe(model.writer);
      expect(effects.slice(beforeEffects), context).toEqual(
        expected.effects.flatMap((effect) =>
          effect.type === "cancel"
            ? ["cancel"]
            : effect.type === "inject"
              ? ["inject:" + effect.input.id]
              : [],
        ),
      );
      for (const [id, input] of Object.entries(model.inputs)) {
        expect(custody.get(id), context).toBe(input.custody);
      }
    }
  } finally {
    for (const [id, gate] of gates) {
      gate.resolve({ type: "receipt", id, outcome: "accepted" });
    }
    for (const delivery of deliveries) {
      delivery.resolve();
    }
    for (const operation of operations) {
      operation.complete();
    }
    await Promise.all([...attempts.values()].map((attempt) => attempt.outcome));
    await Promise.all(operations.map((operation) => operation.ownerSettlement));
  }
}

const noRecoveryDispatch = () => Promise.reject(new Error("a joined resend must not dispatch"));
const joinOnlyRecoveryRuntime: GatewayRecoveryRuntime = {
  prepareFailedWorkerPlacement: noRecoveryDispatch,
  prepareRestartRecovery: noRecoveryDispatch,
  resumeChatInput: noRecoveryDispatch,
  dispatchSessionMethod: noRecoveryDispatch,
  dispatchAgent: noRecoveryDispatch,
  waitForAgent: noRecoveryDispatch,
  sendRecoveryNotice: noRecoveryDispatch,
};

/** A foreground claim selected first, then a startup resend reserved behind it and joined. */
function startForegroundBeforeResend(
  cycle: number,
  beforeJoin: (resend: SessionControllerInput) => void = () => {},
) {
  const key = `agent:main:recovery-join-model:${cycle}`;
  const reservationId = `main-session-recovery:recovery-session:cycle:${cycle}`;
  const foregroundAbort = new AbortController();
  const foreground = reserve(key, {
    adapter: { signal: foregroundAbort.signal },
  });
  const foregroundClaim = tryClaimSessionControllerTask(foreground);
  if (!foregroundClaim) {
    throw new Error("expected the foreground source to own the mailbox");
  }
  const resend = reserve(key, {
    reservationId,
    protocolRunId: "startup-recovery-run",
  });
  beforeJoin(resend);
  const joined = retryRestartRecoveryBeforeSelectedClaim({
    cfg: {},
    claim: foregroundClaim,
    gatewayRuntime: joinOnlyRecoveryRuntime,
    reservationId,
    sessionId: "recovery-session",
    sessionKey: key,
    storePath: "/tmp/openclaw-recovery-model/sessions.json",
  });
  return { foregroundAbort, foreground, foregroundClaim, resend, joined };
}

describe("session controller executable pilot", () => {
  it("gives each owed completion and settle identity exactly one FIFO parent turn", async () => {
    const key = "agent:main:completion-mailbox-model";
    const active = operationFor(key, "active");
    active.setPhase("running");
    const offered: PilotParentInput[] = [
      { id: "user-before", kind: "user", owedAt: 1 },
      { id: "completion:a:1", kind: "completion", owedAt: 2 },
      { id: "completion:a:1", kind: "completion", owedAt: 2 },
      { id: "settle:batch:1:0", kind: "settle", owedAt: 3 },
      { id: "user-after", kind: "user", owedAt: 4 },
    ];
    const expected = modelParentMailbox(offered);
    const sources = offered.map((input, index) =>
      reserve(key, {
        reservationId: input.kind === "user" ? undefined : input.id,
        protocolRunId: input.kind === "user" ? `${input.id}:${index}` : input.id,
      }),
    );
    expect(sources[1]).toBe(sources[2]);
    const unique = sources.filter((source, index) => sources.indexOf(source) === index);
    const turns: string[] = [];
    const pending = unique.map((source) =>
      recordClaim(source, turns, offered[sources.indexOf(source)]!.id),
    );
    active.abortByUser();
    active.complete();
    try {
      for (const claim of pending) {
        await release(await claim);
      }
      expect(turns).toEqual(expected.map((input) => input.id));
      expect(turns).toEqual(["user-before", "completion:a:1", "settle:batch:1:0", "user-after"]);
    } finally {
      for (const source of unique) {
        retireSessionControllerInput(source);
      }
      clearSessionControllerMailbox(unique[0]!.mailbox, () => {});
    }
  });

  it("rebuilds reset completion and settle obligations once in persisted owed order", async () => {
    const key = "agent:main:completion-mailbox-reset-model";
    const owed = modelParentMailbox([
      { id: "settle:later", kind: "settle", owedAt: 20 },
      { id: "completion:earlier", kind: "completion", owedAt: 10 },
    ]).toSorted((a, b) => a.owedAt - b.owedAt);
    const rebuild = () => owed.map((input) => reserve(key, { reservationId: input.id }));
    const initial = rebuild();
    clearSessionControllerMailbox(initial[0]!.mailbox, () => {});
    await Promise.allSettled(initial.map((source) => source.settlement.promise));
    const rebuilt = rebuild();
    const turns: string[] = [];
    try {
      for (const source of rebuilt) {
        await release(await recordClaim(source, turns));
      }
      expect(turns).toEqual(["completion:earlier", "settle:later"]);
    } finally {
      for (const source of rebuilt) {
        retireSessionControllerInput(source);
      }
    }
  });

  it("lets a foreground claim join the startup resend that won the durable claim", async () => {
    const turns: string[] = [];
    let resendTurn: Promise<SessionControllerMailboxClaim> | undefined;
    const { foreground, foregroundClaim, joined } = startForegroundBeforeResend(1, (resend) => {
      resendTurn = recordClaim(resend, turns, "resend");
    });
    try {
      const resendClaim = await resendTurn!;
      expect(foreground.mailbox.claim).toBe(resendClaim);
      releaseSessionControllerClaim(resendClaim);
      await expect(joined).resolves.toBeUndefined();
      expect(foreground.mailbox.claim).toBe(foregroundClaim);
      expect(turns).toEqual(["resend"]);
    } finally {
      await release(foregroundClaim);
    }
  });

  it("never lets a joining foreground retire the resend it did not create (R5)", async () => {
    const { foregroundAbort, foregroundClaim, resend, joined } = startForegroundBeforeResend(2);
    foregroundAbort.abort(new Error("foreground stopped while its predecessor waits"));
    await expect(joined).resolves.toBeUndefined();
    expect(resend.retirementRequested).toBeUndefined();
    expect(resend.mailbox.entries).toContain(resend);
    // The aborted foreground caller releases its custody before the resend starts.
    await release(foregroundClaim);

    const turns: string[] = [];
    releaseSessionControllerClaim(await recordClaim(resend, turns, "resend"));
    await resend.settlement.promise;
    expect(turns).toEqual(["resend"]);
  });

  it("replays 2048 state-aware sequences with delayed receipts (48 generated steps each)", async () => {
    vi.useFakeTimers();
    try {
      for (let seed = 1; seed <= 2048; seed++) {
        await replay(generatePilotSequence(seed), "seed=" + seed);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<{ name: string; events: PilotEvent[] }>([
    {
      name: "keeps finishing cancellation separate from the backend injection capability",
      events: [
        { type: "run" },
        { type: "finish" },
        { type: "offer", input: { id: "still-available", authority: "alice-policy" } },
        { type: "receipt", id: "still-available", outcome: "accepted" },
        { type: "injection-available", available: false },
        { type: "offer", input: { id: "closed", authority: "alice-policy" } },
        { type: "stop" },
        ...deliverySettlement,
      ],
    },
    {
      name: "retains uncertain input custody while refusing another sender during compaction",
      events: [
        { type: "run" },
        { type: "compact", active: true },
        { type: "offer", input: { id: "other-sender", authority: "bob-policy" } },
        { type: "offer", input: { id: "uncertain", authority: "alice-policy" } },
        { type: "receipt", id: "uncertain", outcome: "indeterminate" },
        { type: "revoke" },
        { type: "stop" },
        ...deliverySettlement,
      ],
    },
    {
      name: "rejects a delayed receipt from a same-ID replaced operation",
      events: [
        { type: "run" },
        { type: "offer", input: { id: "old-input", authority: "alice-policy" } },
        ...deliverySettlement,
        { type: "replace" },
        { type: "run" },
        { type: "receipt", id: "old-input", outcome: "accepted" },
        ...deliverySettlement,
      ],
    },
  ])("$name", async ({ name, events }) => replay(events, name));

  it("keeps a restart-interrupted lifecycle lease until the actual owner and delivery settle", async () => {
    const operation = operationFor("agent:main:pilot-lease", "pilot-lease");
    operation.setPhase("running");
    const delivery = createDeferredCore();
    const lease = await beginSessionEffect({
      scope: "pilot-store",
      identities: [operation.key, operation.sessionId],
      assertAllowed: () => {},
      onInterrupt: (reason) => {
        operation.abort(reason);
      },
    });
    const ownerReleased = operation.ownerSettlement.then(() => lease.release());
    let effectSettled = false;
    void lease.released.then(() => {
      effectSettled = true;
    });
    try {
      const interruption = startSessionControllerInterruption({
        scope: "pilot-store",
        identities: [operation.key],
        reason: createAgentRunRestartAbortError(),
      });
      expect(operation.abortSignal.aborted).toBe(true);
      expect(lease.isActive()).toBe(false);
      expect(effectSettled).toBe(false);
      const interrupted = lease.run(async () => {}).catch((error: unknown) => error);
      expect(isAgentRunRestartAbortReason(await interrupted)).toBe(true);
      operation.completeWithAfterClearBarrier(delivery.promise);
      await Promise.resolve();
      expect(effectSettled).toBe(false);
      delivery.reject(new Error("delivery failed"));
      await ownerReleased;
      await interruption.released;
      expect(effectSettled).toBe(true);
      expect(lease.isActive()).toBe(false);
    } finally {
      delivery.resolve();
      operation.complete();
      await ownerReleased;
      lease.release();
    }
  });

  it.each(["old", "new"] as const)(
    "conserves overflow identities against the existing %s queue boundary",
    (dropPolicy) => {
      let model: PilotMailbox = { capacity: 2, waiting: [], retired: [] };
      const queue = {
        cap: 2,
        items: [] as PilotInput[],
        dropPolicy,
        droppedCount: 0,
        summaryLines: [] as string[],
      };
      const retired: string[] = [];
      for (let n = 0; n < 6; n++) {
        const input = { id: "mail-" + n, authority: n % 2 ? "alice-policy" : "bob-policy" };
        model = stepPilotMailbox(model, { type: "enqueue", input, overflow: dropPolicy }).state;
        if (
          applyQueueDropPolicy({
            queue,
            summarize: (item) => item.id,
            onDrop: (items) => retired.push(...items.map((item) => item.id)),
          })
        ) {
          queue.items.push(input);
        } else {
          retired.push(input.id);
        }
        expect(queue.items).toEqual(model.waiting);
        expect(retired).toEqual(model.retired);
        expect(queue.items.length + retired.length).toBe(n + 1);
      }
    },
  );
});

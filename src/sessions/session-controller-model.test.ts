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

/** Calls public owner operations, never the runtime reducer under test. */
async function replay(events: readonly PilotEvent[], label: string) {
  let model = initialPilotState();
  let live = true;
  const sourceRevoked = new Error("source revoked");
  let compacting = false;
  let injectionAvailable = true;
  let writer = true;
  const key = "agent:main:controller-pilot";
  const gates = new Map<
    string,
    ReturnType<typeof createDeferredCore<PilotEvent & { type: "receipt" }>>
  >();
  const attempts = new Map<string, ReplyMessageInjectionAttempt>();
  const custody = new Map<string, PilotCustody>();
  const effects: string[] = [];
  const deliveries: ReturnType<typeof createDeferredCore<void>>[] = [];
  const operations: ReturnType<typeof createReplyOperation>[] = [];
  const create = () => {
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: "pilot-session",
      resetTriggered: false,
    });
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
          const gate = createDeferredCore<PilotEvent & { type: "receipt" }>();
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
          if (gates.has(event.input.id)) {
            custody.set(event.input.id, "offered");
          } else {
            custody.set(event.input.id, (await attempt.outcome).status);
          }
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
  prepareRestartRecovery: noRecoveryDispatch,
  dispatchSessionMethod: noRecoveryDispatch,
  dispatchAgent: noRecoveryDispatch,
  waitForAgent: noRecoveryDispatch,
  sendRecoveryNotice: noRecoveryDispatch,
};

/** A foreground claim selected first, then a startup resend reserved behind it and joined. */
function startForegroundBeforeResend(
  key: string,
  reservationId: string,
  beforeJoin: (resend: SessionControllerInput) => void = () => {},
) {
  const foregroundAbort = new AbortController();
  const foreground = reserveSessionControllerSource(key, {
    policy: { mode: "followup" },
    adapter: { signal: foregroundAbort.signal },
  });
  const foregroundClaim = tryClaimSessionControllerTask(foreground);
  if (!foregroundClaim) {
    throw new Error("expected the foreground source to own the mailbox");
  }
  const resend = reserveSessionControllerSource(key, {
    reservationId,
    protocolRunId: "startup-recovery-run",
    policy: { mode: "followup" },
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
    const active = createReplyOperation({
      sessionKey: key,
      sessionId: "active",
      resetTriggered: false,
    });
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
      reserveSessionControllerSource(key, {
        reservationId: input.kind === "user" ? undefined : input.id,
        protocolRunId: input.kind === "user" ? `${input.id}:${index}` : input.id,
        policy: { mode: "followup" },
      }),
    );
    expect(sources[1]).toBe(sources[2]);
    const unique = sources.filter((source, index) => sources.indexOf(source) === index);
    const sourceIds = new Map(
      unique.map((source) => [source, offered[sources.indexOf(source)]!.id]),
    );
    const turns: string[] = [];
    const pending = unique.map((source) =>
      claimSessionControllerTask(source, () => {
        turns.push(sourceIds.get(source)!);
      }),
    );
    active.abortByUser();
    active.complete();
    try {
      for (const claim of pending) {
        const admitted = await claim;
        releaseSessionControllerClaim(admitted);
        await admitted.settlement.promise;
      }
      expect(turns).toEqual(expected.map((input) => input.id));
      expect(turns.filter((id) => id === "completion:a:1")).toHaveLength(1);
      expect(turns.filter((id) => id === "settle:batch:1:0")).toHaveLength(1);
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
    const initial = owed.map((input) =>
      reserveSessionControllerSource(key, {
        reservationId: input.id,
        policy: { mode: "followup" },
      }),
    );
    clearSessionControllerMailbox(initial[0]!.mailbox, () => {});
    await Promise.allSettled(initial.map((source) => source.settlement.promise));
    const rebuilt = owed.map((input) =>
      reserveSessionControllerSource(key, {
        reservationId: input.id,
        policy: { mode: "followup" },
      }),
    );
    const turns: string[] = [];
    try {
      for (const source of rebuilt) {
        const claim = await claimSessionControllerTask(source, () => {
          turns.push(source.sourceTurnId!);
        });
        releaseSessionControllerClaim(claim);
        await claim.settlement.promise;
      }
      expect(turns).toEqual(["completion:earlier", "settle:later"]);
    } finally {
      for (const source of rebuilt) {
        retireSessionControllerInput(source);
      }
    }
  });

  it("lets a foreground claim join the startup resend that won the durable claim", async () => {
    const key = "agent:main:recovery-join-model";
    const turns: string[] = [];
    let resendTurn: Promise<SessionControllerMailboxClaim> | undefined;
    // The startup RPC already waits behind the foreground claim when the foreground joins.
    const { foreground, foregroundClaim, joined } = startForegroundBeforeResend(
      key,
      "main-session-recovery:recovery-session:cycle:1",
      (resend) => {
        resendTurn = claimSessionControllerTask(resend, () => {
          turns.push("resend");
        });
      },
    );
    try {
      const resendClaim = await resendTurn!;
      expect(foreground.mailbox.claim).toBe(resendClaim);
      releaseSessionControllerClaim(resendClaim);
      await expect(joined).resolves.toBeUndefined();
      expect(foreground.mailbox.claim).toBe(foregroundClaim);
      expect(turns).toEqual(["resend"]);
    } finally {
      releaseSessionControllerClaim(foregroundClaim);
      await foregroundClaim.settlement.promise;
    }
  });

  it("never lets a joining foreground retire the resend it did not create (R5)", async () => {
    const key = "agent:main:recovery-join-retire-model";
    const { foregroundAbort, foregroundClaim, resend, joined } = startForegroundBeforeResend(
      key,
      "main-session-recovery:recovery-session:cycle:2",
    );
    foregroundAbort.abort(new Error("foreground stopped while its predecessor waits"));
    await expect(joined).resolves.toBeUndefined();
    expect(resend.retirementRequested).toBeUndefined();
    expect(resend.mailbox.entries).toContain(resend);
    // The aborted foreground caller releases its custody before the resend starts.
    releaseSessionControllerClaim(foregroundClaim);
    await foregroundClaim.settlement.promise;

    const turns: string[] = [];
    const resendClaim = await claimSessionControllerTask(resend, () => {
      turns.push("resend");
    });
    releaseSessionControllerClaim(resendClaim);
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

  it("keeps finishing cancellation separate from the backend injection capability", async () => {
    await replay(
      [
        { type: "run" },
        { type: "finish" },
        { type: "offer", input: { id: "still-available", authority: "alice-policy" } },
        { type: "receipt", id: "still-available", outcome: "accepted" },
        { type: "injection-available", available: false },
        { type: "offer", input: { id: "closed", authority: "alice-policy" } },
        { type: "stop" },
        { type: "complete" },
        { type: "delivery-settled" },
      ],
      "finishing capability",
    );
  });

  it("retains uncertain input custody while refusing another sender during compaction", async () => {
    await replay(
      [
        { type: "run" },
        { type: "compact", active: true },
        { type: "offer", input: { id: "other-sender", authority: "bob-policy" } },
        { type: "offer", input: { id: "uncertain", authority: "alice-policy" } },
        { type: "receipt", id: "uncertain", outcome: "indeterminate" },
        { type: "revoke" },
        { type: "stop" },
        { type: "complete" },
        { type: "delivery-settled" },
      ],
      "indeterminate custody",
    );
  });

  it("rejects a delayed receipt from a same-ID replaced operation", async () => {
    await replay(
      [
        { type: "run" },
        { type: "offer", input: { id: "old-input", authority: "alice-policy" } },
        { type: "complete" },
        { type: "delivery-settled" },
        { type: "replace" },
        { type: "run" },
        { type: "receipt", id: "old-input", outcome: "accepted" },
        { type: "complete" },
        { type: "delivery-settled" },
      ],
      "exact-instance replacement",
    );
  });

  it("keeps a restart-interrupted lifecycle lease until the actual owner and delivery settle", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:pilot-lease",
      sessionId: "pilot-lease",
      resetTriggered: false,
    });
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

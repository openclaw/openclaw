import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  controllerSource as reserve,
  controllerTarget,
  controllerTurn as turnParams,
} from "./controller-core.test-support.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { ReplyRunAlreadyActiveError } from "./session-controller.contracts.js";
import { captureSessionTarget, runSessionMutation } from "./session-controller.lifecycle.js";
import {
  abortSessionControllerInput as abortInput,
  claimSessionControllerTask as claimTask,
  releaseSessionControllerClaim as releaseClaim,
  reserveSessionControllerSource as reserveSource,
  retireSessionControllerInput as retireInput,
  tryClaimSessionControllerTask as tryClaim,
  trackSessionControllerSourceWork as trackWork,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import {
  getSessionControllerEntry as getEntry,
  sessionControllers,
  type SessionControllerEntry,
} from "./session-controller.state.js";

const turnKinds = ["visible", "queued_followup", "direct"] as const;
afterEach(() => {
  sessionControllers.clear();
});

function targetFor(label: string, incarnation = `${label}-session`) {
  return controllerTarget(`/synthetic/${label}/sessions.json`, `agent:main:${label}`, incarnation);
}

async function releaseInput(
  input: ReturnType<typeof reserve>,
  pending: ReturnType<typeof claimTask>,
) {
  retireInput(input);
  const claim = await pending.catch(() => undefined);
  if (claim) {
    releaseClaim(claim);
  }
  await input.settlement.promise;
}

it("runs a turn its own mutation requests ahead of the inputs that mutation keeps waiting", async () => {
  // Manual compaction requests its turn from inside the idle session's mutation fence.
  const target = targetFor("mutation-owned-turn");
  const order: string[] = [];
  const cancel = new AbortController();
  const kept = reserve(target);
  const compaction = runSessionMutation({
    target,
    kind: "compaction",
    policy: "preempt",
    preempt: { activeRun: "abort-if-abortable", waitingInputs: "keep" },
    run: async () => {
      const turn = withSessionTurn(
        { ...turnParams(target), abortSignal: cancel.signal },
        async (operation) => {
          order.push("mutation turn");
          return operation?.key;
        },
      );
      void turn.catch(() => {});
      // The selector claims synchronously, so a refused turn is visible here instead of hanging.
      const selected = getEntry(target.sessionKey, target).mailbox?.claim;
      expect(selected?.inputs.includes(kept)).toBe(false);
      return await turn;
    },
  });
  const keptClaim = claimTask(kept, () => order.push("kept input"));
  try {
    await expect(compaction).resolves.toBe(target.sessionKey);
    await keptClaim;
    expect(order).toEqual(["mutation turn", "kept input"]);
  } finally {
    cancel.abort(new Error("test cleanup"));
    await compaction.catch(() => {});
    await releaseInput(kept, keptClaim);
  }
});

it.each([
  { ambient: true, materialize: true },
  { ambient: false, materialize: false },
  { ambient: false, materialize: true },
])(
  "relays borrowed caller cancellation (ambient=$ambient, materialize=$materialize)",
  async ({ ambient, materialize }) => {
    const target = targetFor("borrowed-cancellation");
    const params = ambient
      ? {
          storePath: target.storeScope,
          sessionKey: target.sessionKey,
          sessionId: target.incarnation,
        }
      : turnParams(target, false);
    const caller = new AbortController();
    const [started, release] = [createDeferred(), createDeferred()];
    let borrowedSignal: AbortSignal | undefined;
    await withSessionTurn(params, async (outer, outerSignal) => {
      const borrowed = withSessionTurn(
        { ...(ambient ? params : turnParams(target, materialize)), abortSignal: caller.signal },
        async (operation, signal) => {
          borrowedSignal = signal;
          started.resolve();
          await release.promise;
          expect(operation?.abortSignal.aborted ?? false).toBe(false);
        },
      );
      try {
        await started.promise;
        caller.abort("caller cancelled");
        expect(borrowedSignal).toMatchObject({ aborted: true, reason: "caller cancelled" });
        expect(outerSignal.aborted).toBe(false);
        expect(outer?.abortSignal.aborted ?? false).toBe(false);
      } finally {
        release.resolve();
        await borrowed;
      }
    });
  },
);

it.each([false, true])(
  "does not borrow an ambient owner for another reserved input (operation=%s)",
  async (materialize) => {
    const target = captureSessionTarget({
      storeScope: "/synthetic/ambient-input/sessions.json",
      sessionKey: `agent:main:ambient-input-${materialize}`,
      incarnation: "incarnation",
    });
    const params = turnParams(target, materialize);
    let input: ReturnType<typeof reserveSource> | undefined;
    let nested: Promise<void> | undefined;
    let nestedStarted = false;
    let nestedOwnedInput = false;
    try {
      const startedInsidePredecessor = await withSessionTurn(params, async () => {
        const reserved = reserve(target);
        input = reserved;
        nested = withSessionTurn({ ...params, controllerInput: reserved }, async () => {
          nestedStarted = true;
          nestedOwnedInput = reserved.claim?.inputs.includes(reserved) === true;
        });
        await Promise.resolve();
        return nestedStarted;
      });
      await nested;
      expect(startedInsidePredecessor).toBe(false);
      expect(nestedStarted).toBe(true);
      expect(nestedOwnedInput).toBe(true);
    } finally {
      if (input) {
        retireInput(input);
        await input.settlement.promise;
      }
      await nested;
    }
  },
);

it.each(turnKinds)(
  "keeps direct %s admission behind an unclaimed source's cleanup receipt",
  async (kind) => {
    const sessionId = "cleanup-session";
    const target = targetFor(`consumed-admission-${kind}`, sessionId);
    const [cleanupStarted, cleanup] = [createDeferred(), createDeferred()];
    const input = reserve(target, {
      adapter: {
        onSettled: async () => {
          cleanupStarted.resolve();
          await cleanup.promise;
        },
      },
    });
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    const create = () => {
      operation = createReplyOperation({
        ...turnParams(target),
        sessionId,
        resetTriggered: false,
        turnKind: kind,
      });
    };
    retireInput(input);
    try {
      await cleanupStarted.promise;
      expect(create).toThrow(ReplyRunAlreadyActiveError);
      cleanup.resolve();
      await input.settlement.promise;
      expect(create).not.toThrow();
    } finally {
      cleanup.resolve();
      operation?.complete();
      await input.settlement.promise;
      await operation?.ownerSettlement;
    }
  },
);

it("keeps interrupt execution behind a cancelled unclaimed source's raw cleanup", async () => {
  const target = targetFor("retiring-admission");
  const cleanup = createDeferred();
  const predecessor = reserve(target);
  trackWork(predecessor, cleanup.promise);
  abortInput(predecessor, new Error("interrupt"));
  const successor = reserve(target, {
    policy: { mode: "interrupt" },
  });
  let started = false;
  const pending = claimTask(successor, () => {
    started = true;
  });
  try {
    // The real selector runs synchronously; unresolved native cleanup still owns admission.
    expect(started).toBe(false);
    cleanup.resolve();
    await predecessor.settlement.promise;
    await pending;
    expect(started).toBe(true);
  } finally {
    cleanup.resolve();
    await predecessor.settlement.promise;
    await releaseInput(successor, pending);
  }
});

it.each([
  { kind: "visible", deliveryPending: true },
  { kind: "direct", deliveryPending: true },
  { kind: "queued_followup", deliveryPending: true },
  { kind: "queued_followup", deliveryPending: false },
] as const)(
  "makes mailbox and direct creation agree for $kind (delivery pending=$deliveryPending)",
  async ({ kind, deliveryPending }) => {
    const blocked = deliveryPending && kind === "queued_followup";
    const sessionKey = `agent:main:admission-parity:${kind}:${deliveryPending}`;
    const entry = getEntry(sessionKey);
    const input = reserveSource(sessionKey, { policy: { mode: "followup" } });
    if (deliveryPending) {
      entry.followupBarrier = {} as NonNullable<SessionControllerEntry["followupBarrier"]>;
    }

    const claim = tryClaim(input, kind);
    expect(Boolean(claim)).toBe(!blocked);
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    const create = () => {
      operation = createReplyOperation({
        sessionKey,
        sessionId: `session-${kind}`,
        resetTriggered: false,
        turnKind: kind,
        mailboxClaim: claim,
      });
    };
    if (blocked) {
      expect(create).toThrow("Reply follow-up admission is blocked");
    } else {
      expect(create).not.toThrow();
    }

    operation?.complete();
    if (claim) {
      releaseClaim(claim);
      await claim.settlement.promise;
    } else {
      entry.followupBarrier = undefined;
      retireInput(input);
      await input.settlement.promise;
    }
  },
);

import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { ReplyRunAlreadyActiveError } from "./session-controller.contracts.js";
import { captureSessionTarget, runSessionMutation } from "./session-controller.lifecycle.js";
import {
  abortSessionControllerInput,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
  trackSessionControllerSourceWork,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import {
  getSessionControllerEntry,
  sessionControllers,
  type SessionControllerEntry,
} from "./session-controller.state.js";

const turnKinds = ["visible", "heartbeat", "queued_followup", "direct"] as const;
afterEach(() => {
  sessionControllers.clear();
});

function targetFor(label: string, incarnation = `${label}-session`) {
  return captureSessionTarget({
    storeScope: `/synthetic/${label}/sessions.json`,
    sessionKey: `agent:main:${label}`,
    incarnation,
  });
}

function reserve(
  target: ReturnType<typeof targetFor>,
  options: Partial<Parameters<typeof reserveSessionControllerSource>[1]> = {},
) {
  return reserveSessionControllerSource(target.sessionKey, {
    target,
    policy: { mode: "followup" },
    ...options,
  });
}

function turnParams(target: ReturnType<typeof targetFor>, materialize = true) {
  return {
    target,
    sessionKey: target.sessionKey,
    ...(materialize ? { sessionId: target.incarnation } : {}),
  };
}

async function releaseInput(
  input: ReturnType<typeof reserve>,
  pending: ReturnType<typeof claimSessionControllerTask>,
) {
  retireSessionControllerInput(input);
  const claim = await pending.catch(() => undefined);
  if (claim) {
    releaseSessionControllerClaim(claim);
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
        {
          ...turnParams(target),
          abortSignal: cancel.signal,
        },
        async (operation) => {
          order.push("mutation turn");
          return operation?.key;
        },
      );
      void turn.catch(() => {});
      // The selector claims synchronously, so a refused turn is visible here instead of hanging.
      const selected = getSessionControllerEntry(target.sessionKey, target).mailbox?.claim;
      expect(selected?.inputs.includes(kept)).toBe(false);
      return await turn;
    },
  });
  const keptClaim = claimSessionControllerTask(kept, () => order.push("kept input"));
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

it("relays caller cancellation through a borrowed ambient turn", async () => {
  const params = {
    storePath: "/synthetic/borrowed-cancellation/sessions.json",
    sessionKey: "agent:main:borrowed-cancellation",
    sessionId: "borrowed-cancellation-session",
  };
  const caller = new AbortController();
  const [callbackStarted, releaseCallback] = [createDeferred(), createDeferred()];
  let borrowedSignal: AbortSignal | undefined;
  await withSessionTurn(params, async (operation) => {
    const borrowed = withSessionTurn(
      { ...params, abortSignal: caller.signal },
      async (_, signal) => {
        borrowedSignal = signal;
        callbackStarted.resolve();
        await releaseCallback.promise;
      },
    );
    await callbackStarted.promise;
    try {
      caller.abort("caller cancelled");
      expect(borrowedSignal).toMatchObject({ aborted: true, reason: "caller cancelled" });
      expect(operation?.abortSignal.aborted).toBe(false);
    } finally {
      releaseCallback.resolve();
      await borrowed;
    }
  });
});

it.each([false, true])(
  "relays caller cancellation through a borrowed unbound claim (materialize=%s)",
  async (materialize) => {
    const target = captureSessionTarget({
      storeScope: "/synthetic/borrowed-claim/sessions.sqlite",
      sessionKey: "agent:main:borrowed-claim",
      incarnation: "borrowed-claim-session",
    });
    const caller = new AbortController();
    await withSessionTurn(turnParams(target, false), async (_, outerSignal) => {
      await withSessionTurn(
        {
          ...turnParams(target, materialize),
          abortSignal: caller.signal,
        },
        async (operation, signal) => {
          caller.abort("nested caller cancelled");
          expect(signal).toMatchObject({ aborted: true, reason: "nested caller cancelled" });
          expect(outerSignal.aborted).toBe(false);
          expect(operation?.abortSignal.aborted ?? false).toBe(false);
        },
      );
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
    let input: ReturnType<typeof reserveSessionControllerSource> | undefined;
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
        retireSessionControllerInput(input);
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
    retireSessionControllerInput(input);
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
  trackSessionControllerSourceWork(predecessor, cleanup.promise);
  abortSessionControllerInput(predecessor, new Error("interrupt"));
  const successor = reserve(target, {
    policy: { mode: "interrupt" },
  });
  let started = false;
  const pending = claimSessionControllerTask(successor, () => {
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

it.each(
  turnKinds.flatMap((kind) => [
    { kind, deliveryPending: false },
    { kind, deliveryPending: true },
  ]),
)(
  "makes mailbox and direct creation agree for $kind (delivery pending=$deliveryPending)",
  async ({ kind, deliveryPending }) => {
    const blocked = deliveryPending && (kind === "heartbeat" || kind === "queued_followup");
    const sessionKey = `agent:main:admission-parity:${kind}:${deliveryPending}`;
    const entry = getSessionControllerEntry(sessionKey);
    const input = reserveSessionControllerSource(sessionKey, { policy: { mode: "followup" } });
    if (deliveryPending) {
      entry.followupBarrier = {} as NonNullable<SessionControllerEntry["followupBarrier"]>;
    }

    const claim = tryClaimSessionControllerTask(input, kind);
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
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    } else {
      entry.followupBarrier = undefined;
      retireSessionControllerInput(input);
      await input.settlement.promise;
    }
  },
);

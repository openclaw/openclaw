import { afterEach, expect, it, vi } from "vitest";
import { diagnosticLogger } from "../logging/diagnostic-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { ReplyRunAlreadyActiveError } from "./session-controller.contracts.js";
import {
  getSessionControllerSourceIdentity,
  resolveReplyRunForCurrentSessionId,
} from "./session-controller.identity.js";
import {
  resolveActiveReplyOperationForSessionId,
  createReplyOperation,
  getSessionControllerOperation,
  waitForSessionRunIdle,
} from "./session-controller.js";
import {
  captureSessionTarget,
  getCurrentSessionControllerClaim,
  runSessionMutation,
  startSessionControllerInterruption,
  captureSessionControllerSettlement,
  bindSessionControllerTarget,
} from "./session-controller.lifecycle.js";
import {
  adoptSessionControllerSource,
  reserveSessionControllerSource,
  claimSessionControllerTask,
  captureSessionControllerSourceSettlement,
  releaseSessionControllerClaim,
  clearSessionControllerMailbox,
  holdSessionControllerSourceWithdrawal,
  abortSessionControllerInput,
  retireSessionControllerInput,
  retargetSessionControllerSource,
  updateSessionControllerSourcePolicy,
  tryClaimSessionControllerTask,
} from "./session-controller.mailbox.js";
import { isSessionRunActive } from "./session-controller.queries.js";
import {
  findSessionControllerEntry,
  getSessionControllerEntryForOperation,
  sessionControllers,
} from "./session-controller.state.js";

const key = "agent:main:physical-identity";
const target = (storeScope: string, sessionKey = key, incarnation = "incarnation") =>
  captureSessionTarget({ storeScope, sessionKey, incarnation });
afterEach(async () => {
  const receipts: Promise<void>[] = [];
  // Capture owners before cleanup can mutate the registry or publish a successor.
  const capturedOwners = Array.from(sessionControllers.values());
  for (const entry of capturedOwners) {
    if (!entry.aliases.has(key)) {
      continue;
    }
    entry.active?.complete();
    const mailbox = entry.mailbox;
    if (mailbox) {
      clearSessionControllerMailbox(mailbox, () => {});
      if (mailbox.claim) {
        receipts.push(mailbox.claim.settlement.promise);
        releaseSessionControllerClaim(mailbox.claim);
      }
    }
  }
  await Promise.allSettled(receipts);
});

it("treats equal active identities in two stores as busy and mutates only the selected owner", async () => {
  const a = target("/stores/a.sqlite");
  const b = target("/stores/b.sqlite");
  const enteredA = createDeferredCore();
  const enteredB = createDeferredCore();
  const doneA = createDeferredCore();
  const doneB = createDeferredCore();
  const runA = withSessionTurn(
    { sessionKey: key, sessionId: "incarnation", target: a },
    async (operation) => {
      expect(operation?.key).toBe(key);
      enteredA.resolve();
      await doneA.promise;
    },
  );
  const runB = withSessionTurn(
    { sessionKey: key, sessionId: "incarnation", target: b },
    async (operation) => {
      expect(operation?.key).toBe(key);
      enteredB.resolve();
      await doneB.promise;
    },
  );
  await Promise.all([enteredA.promise, enteredB.promise]);
  const ownerA = getSessionControllerOperation(key, a);
  const ownerB = getSessionControllerOperation(key, b);
  expect(ownerA).toBeDefined();
  expect(ownerB).toBeDefined();
  expect(ownerA).not.toBe(ownerB);
  using warning = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
  expect(resolveReplyRunForCurrentSessionId("incarnation")).toEqual({
    kind: "ambiguous",
    operations: [ownerA, ownerB],
  });
  expect(isSessionRunActive("incarnation")).toBe(true);
  expect(() => resolveActiveReplyOperationForSessionId("incarnation")).toThrow(
    ReplyRunAlreadyActiveError,
  );
  expect(() =>
    createReplyOperation({ sessionKey: key, sessionId: "incarnation", resetTriggered: false }),
  ).toThrow(ReplyRunAlreadyActiveError);
  expect(() => getSessionControllerOperation(key)).toThrow(ReplyRunAlreadyActiveError);
  const entryIds = [ownerA, ownerB]
    .map((operation) => getSessionControllerEntryForOperation(operation!).id)
    .toSorted()
    .join(",");
  expect(warning).toHaveBeenCalledWith(
    `ambiguous session controller identity: sessionId=incarnation entryIds=${entryIds}`,
  );
  let idle = false;
  const idleReceipt = waitForSessionRunIdle(key).then((result) => {
    idle = result;
    return result;
  });
  await Promise.resolve();
  expect(idle).toBe(false);
  const preparation = createDeferredCore();
  const mutation = runSessionMutation({
    target: a,
    kind: "reset",
    policy: "preempt",
    preempt: { activeRun: "abort", waitingInputs: "cancel" },
    prepare: async ({ operations }) => {
      expect(operations).toEqual([ownerA]);
      preparation.resolve();
    },
    run: async () => expect(ownerB?.abortSignal.aborted).toBe(false),
  });
  await preparation.promise;
  doneA.resolve();
  await Promise.all([runA, mutation]);
  await Promise.resolve();
  expect(idle).toBe(false);
  expect(ownerB?.abortSignal.aborted).toBe(false);
  doneB.resolve();
  await runB;
  await expect(idleReceipt).resolves.toBe(true);
});

it("aliases of one physical incarnation share the same selector", async () => {
  const first = reserveSessionControllerSource(key, {
    target: target("/stores/aliases.sqlite"),
    policy: { mode: "followup" },
  });
  const aliasKey = "agent:main:alias";
  const second = reserveSessionControllerSource(aliasKey, {
    target: target("/stores/aliases.sqlite", aliasKey),
    policy: { mode: "followup" },
  });
  expect(second.mailbox).toBe(first.mailbox);
  const claim = await claimSessionControllerTask(first, () => {});
  const selected = vi.fn();
  const next = claimSessionControllerTask(second, selected);
  expect(selected).not.toHaveBeenCalled();
  releaseSessionControllerClaim(claim);
  const nextClaim = await next;
  expect(selected).toHaveBeenCalledOnce();
  releaseSessionControllerClaim(nextClaim);
  await nextClaim.settlement.promise;
});

it("keeps nested raw-key turns owned by separate agents in one physical store", async () => {
  const agentTarget = (agentId: string) =>
    captureSessionTarget({
      storeScope: "/stores/shared-global.sqlite",
      sessionKey: "global",
      incarnation: "incarnation",
      agentId,
    });
  const outerTarget = agentTarget("main");
  const nestedTarget = agentTarget("other");
  await withSessionTurn(
    { sessionKey: "global", sessionId: "incarnation", target: outerTarget },
    async (outer) => {
      expect(outer).toBeDefined();
      expect(() => outer!.updateSessionKey("global", "other")).toThrow(
        "Changing agent owner requires matching destination admission",
      );
      expect(outer!.agentId).toBe("main");
      await withSessionTurn(
        { sessionKey: "global", sessionId: "incarnation", target: nestedTarget },
        async (nested) => {
          expect(nested).toBeDefined();
          expect(nested).not.toBe(outer);
          expect(getSessionControllerOperation("global", outerTarget)).toBe(outer);
          expect(getSessionControllerOperation("global", nestedTarget)).toBe(nested);
        },
      );
      await expect(
        withSessionTurn(
          {
            sessionKey: "global",
            sessionId: "incarnation",
            target: nestedTarget,
            replyOperation: outer,
          },
          async () => {},
        ),
      ).rejects.toThrow("does not match its session controller admission");
      expect(() => bindSessionControllerTarget(outer!, nestedTarget)).toThrow(
        "Cannot move a controller between agent owners",
      );
      expect(getSessionControllerEntryForOperation(outer!).target).toBe(outerTarget);
    },
  );
});

it("deduplicates one reserved delivery identity and rejects conflicting reuse", () => {
  const physical = target("/stores/reservation.sqlite");
  const first = reserveSessionControllerSource(key, {
    target: physical,
    reservationId: "subagent-completion:run-1:0",
    protocolRunId: "run-1",
    policy: { mode: "followup" },
  });
  const second = reserveSessionControllerSource(key, {
    target: physical,
    reservationId: "subagent-completion:run-1:0",
    protocolRunId: "run-1",
    policy: { mode: "followup" },
  });

  expect(second).toBe(first);
  expect(first.mailbox.entries).toEqual([first]);
  expect(() =>
    reserveSessionControllerSource(key, {
      target: physical,
      reservationId: "subagent-completion:run-1:0",
      protocolRunId: "different-run",
      policy: { mode: "followup" },
    }),
  ).toThrow("different delivery");
  expect(() =>
    reserveSessionControllerSource(key, {
      target: physical,
      reservationId: "subagent-completion:run-1:0",
      protocolRunId: "run-1",
      policy: { mode: "steer" },
    }),
  ).toThrow("different delivery");
  expect(() =>
    reserveSessionControllerSource(key, {
      target: target("/stores/other.sqlite"),
      reservationId: "subagent-completion:run-1:0",
      protocolRunId: "run-1",
      policy: { mode: "followup" },
    }),
  ).toThrow("different delivery");
});

it("adopts only the exact unclaimed reserved source", async () => {
  const physical = target("/stores/rpc-adoption.sqlite");
  const adapter = {};
  const input = reserveSessionControllerSource(key, {
    target: captureSessionTarget({ storeScope: physical.storeScope, sessionKey: key }),
    reservationId: "subagent-settle:batch:0",
    policy: { mode: "followup" },
  });

  expect(() =>
    adoptSessionControllerSource(input, {
      protocolRunId: "settle-run",
      target: target("/stores/foreign.sqlite"),
      policy: { mode: "followup" },
      adapter,
    }),
  ).toThrow("foreign or claimed");
  adoptSessionControllerSource(input, {
    protocolRunId: "settle-run",
    target: physical,
    policy: { mode: "followup" },
    adapter,
  });
  expect(getSessionControllerSourceIdentity(input)).toMatchObject({
    sessionKey: key,
    sessionId: "incarnation",
  });
  expect(input.protocolRunId).toBe("settle-run");
  expect(input.sourceAdapter).toBe(adapter);
  expect(input.custody.rpcAdopted).toBe(true);
  expect(() =>
    adoptSessionControllerSource(input, {
      protocolRunId: "settle-run",
      target: physical,
      policy: { mode: "followup" },
      adapter,
    }),
  ).toThrow("foreign or claimed");

  const claimedTarget = target("/stores/rpc-claimed.sqlite");
  const claimed = reserveSessionControllerSource(key, {
    target: claimedTarget,
    policy: { mode: "followup" },
  });
  const claim = await claimSessionControllerTask(claimed, () => {});
  expect(() =>
    adoptSessionControllerSource(claimed, {
      protocolRunId: "claimed-run",
      target: claimedTarget,
      policy: { mode: "followup" },
      adapter: {},
    }),
  ).toThrow("foreign or claimed");
  releaseSessionControllerClaim(claim);
  await claim.settlement.promise;
});

it.each(
  (["signal", "authority"] as const).flatMap((binding) =>
    [false, true].map((alreadyAborted) => ({ binding, alreadyAborted })),
  ),
)(
  "binds adopted $binding cancellation (alreadyAborted=$alreadyAborted)",
  async ({ binding, alreadyAborted }) => {
    const physical = target("/stores/adopted-cancellation.sqlite");
    const input = reserveSessionControllerSource(key, {
      target: physical,
      policy: { mode: "followup" },
    });
    const originalSignal = input.abortSignal;
    const cancellation = new AbortController();
    const reason = new Error("adopted source cancelled");
    if (alreadyAborted) {
      cancellation.abort(reason);
    }
    adoptSessionControllerSource(input, {
      protocolRunId: "adopted-cancellation",
      target: physical,
      policy: { mode: "followup" },
      adapter:
        binding === "signal"
          ? { signal: cancellation.signal }
          : { authority: { assertCurrent() {}, signal: cancellation.signal } },
    });
    try {
      cancellation.abort(reason);
      expect(input.abortSignal).toBe(originalSignal);
      expect(originalSignal.aborted).toBe(true);
      expect(originalSignal.reason).toBe(reason);
      const start = vi.fn();
      await expect(claimSessionControllerTask(input, start)).rejects.toBe(reason);
      expect(start).not.toHaveBeenCalled();
    } finally {
      retireSessionControllerInput(input);
      await input.settlement.promise;
    }
  },
);

it("moves one unbound command source into target ordering without replacing its receipt", async () => {
  const source = reserveSessionControllerSource(key, {
    target: target("/stores/command.sqlite", key, "command-source"),
    protocolRunId: " exact command id ",
    policy: { mode: "followup" },
  });
  const receipt = captureSessionControllerSourceSettlement(source);
  const originalMailbox = source.mailbox;
  expect(() => retargetSessionControllerSource(source, target("/stores/other.sqlite"))).toThrow(
    "physical store",
  );
  expect(source.mailbox).toBe(originalMailbox);
  expect(originalMailbox.entries).toContain(source);
  const destination = target("/stores/command.sqlite", key + ":target", "target-row");
  const older = reserveSessionControllerSource(destination.sessionKey, {
    target: destination,
    policy: { mode: "followup" },
  });
  retargetSessionControllerSource(source, destination);
  expect(captureSessionControllerSourceSettlement(source)).toBe(receipt);
  expect(source.protocolRunId).toBe(" exact command id ");
  expect(findSessionControllerEntry(key)).toBeUndefined();
  expect(tryClaimSessionControllerTask(source)).toBeUndefined();
  updateSessionControllerSourcePolicy(source, { mode: "interrupt" });
  const priority = tryClaimSessionControllerTask(source);
  expect(priority?.inputs).toEqual([source]);
  expect(() => retargetSessionControllerSource(source, target("/stores/other.sqlite"))).toThrow();
  releaseSessionControllerClaim(priority!);
  await receipt;
  await priority!.settlement.promise;
  const next = await claimSessionControllerTask(older, () => {});
  expect(next.inputs).toEqual([older]);
  releaseSessionControllerClaim(next);
  await next.settlement.promise;
});

it("adopts a real incarnation under the same unbound outer claim and borrows required maintenance", async () => {
  const physical = captureSessionTarget({ storeScope: "/stores/fresh.sqlite", sessionKey: key });
  await withSessionTurn({ sessionKey: key, target: physical }, async (unbound) => {
    expect(unbound).toBeUndefined();
    const claim = getCurrentSessionControllerClaim();
    expect(claim?.operation).toBeUndefined();
    await withSessionTurn(
      { sessionKey: key, sessionId: "created-row", target: physical },
      async (operation) => {
        expect(operation?.sessionId).toBe("created-row");
        expect(getCurrentSessionControllerClaim()).toBe(claim);
        expect(claim?.operation).toBe(operation);
        if (!operation) {
          throw new Error("Missing adopted operation");
        }
        for (const phase of ["preflight_compacting", "memory_flushing"] as const) {
          operation.setPhase(phase);
          await withSessionTurn(
            {
              sessionKey: key,
              sessionId: "created-row",
              target: physical,
              replyOperation: operation,
            },
            async (maintenance) => expect(maintenance).toBe(operation),
          );
        }
      },
    );
    expect(claim?.operation?.result).toBeNull();
  });
});

it("reuses an early input and cancels reset preparation without completing its live callback", async () => {
  const physical = captureSessionTarget({
    storeScope: "/stores/preparing.sqlite",
    sessionKey: key,
  });
  const input = reserveSessionControllerSource(key, {
    target: physical,
    policy: { mode: "followup" },
  });
  const started = createDeferredCore();
  const release = createDeferredCore();
  const work = withSessionTurn(
    { sessionKey: key, target: physical, controllerInput: input },
    async (operation, signal) => {
      expect(operation).toBeUndefined();
      expect(getCurrentSessionControllerClaim()?.inputs).toEqual([input]);
      expect(input.mailbox.entries).toEqual([input]);
      started.resolve();
      await release.promise;
      expect(signal.aborted).toBe(true);
    },
  );
  await started.promise;
  const interruption = startSessionControllerInterruption({ target: physical });
  const settled = vi.fn();
  void interruption.released.then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  release.resolve();
  await work;
  await interruption.released;
  expect(settled).toHaveBeenCalledOnce();
});

it("holds uncertain injection and source cleanup through clear while allowing a fresh signal afterward", async () => {
  const physical = target("/stores/injection.sqlite");
  const cleanup = createDeferredCore();
  const input = reserveSessionControllerSource(key, {
    target: physical,
    policy: { mode: "followup" },
    adapter: { onSettled: () => cleanup.promise },
  });
  const injection = createDeferredCore<boolean>();
  const settle = vi.fn(injection.resolve);
  input.phase = "injecting";
  input.injection = { predecessor: Promise.resolve(true), settled: injection.promise, settle };
  clearSessionControllerMailbox(input.mailbox, () => {});
  expect(settle).not.toHaveBeenCalled();
  expect(input.mailbox.entries).toContain(input);
  const fresh = reserveSessionControllerSource(key, {
    target: physical,
    policy: { mode: "followup" },
  });
  expect(fresh.abortSignal.aborted).toBe(false);
  const started = vi.fn();
  const queued = claimSessionControllerTask(fresh, started);
  expect(started).not.toHaveBeenCalled();
  const receipt = captureSessionControllerSettlement({ target: physical });
  let ended = false;
  void captureSessionControllerSourceSettlement(input).then(() => {
    ended = true;
  });
  injection.resolve(true);
  input.injection = undefined;
  input.phase = "waiting";
  retireSessionControllerInput(input);
  await Promise.resolve();
  expect(ended).toBe(false);
  expect(started).not.toHaveBeenCalled();
  cleanup.resolve();
  await captureSessionControllerSourceSettlement(input);
  const claim = await queued;
  expect(started).toHaveBeenCalledOnce();
  releaseSessionControllerClaim(claim);
  await receipt;
});

it("retains claimed source adoption until the callback settles", async () => {
  const input = reserveSessionControllerSource(key, {
    target: target("/stores/adoption.sqlite"),
    policy: { mode: "followup" },
  });
  const claim = await claimSessionControllerTask(input, () => {});
  const adoption = createDeferredCore();
  input.custody.adopting = adoption.promise;
  clearSessionControllerMailbox(input.mailbox, () => {});
  releaseSessionControllerClaim(claim);
  expect(claim.released).toBe(false);
  expect(input.mailbox.claim).toBe(claim);
  input.custody.adopting = undefined;
  adoption.resolve();
  await claim.settlement.promise;
  expect(input.phase).toBe("consumed");
});

it("cancels atomically while holding selection and refuses unavailable withdrawal", async () => {
  const input = reserveSessionControllerSource(key, {
    target: target("/stores/withdraw.sqlite"),
    policy: { mode: "followup" },
  });
  const hold = holdSessionControllerSourceWithdrawal(input);
  const selected = vi.fn();
  const pending = claimSessionControllerTask(input, selected);
  const reason = new Error("Source cancelled by request");
  const rejection = expect(pending).rejects.toBe(reason);
  expect(abortSessionControllerInput(input)).toBe(false);
  expect(hold.cancel(() => {}, reason)).toBe(true);
  hold();
  await rejection;
  expect(selected).not.toHaveBeenCalled();
  expect(() => holdSessionControllerSourceWithdrawal(input)).toThrow(/unavailable/);
});

it("stale disposal cannot delete a successor created by settlement callbacks", async () => {
  const physical = target("/stores/reentrant.sqlite");
  let successor: ReturnType<typeof reserveSessionControllerSource> | undefined;
  const input = reserveSessionControllerSource(key, {
    target: physical,
    policy: { mode: "followup" },
    adapter: {
      onSettled: () => {
        successor = reserveSessionControllerSource(key, {
          target: physical,
          policy: { mode: "followup" },
        });
      },
    },
  });
  const mailbox = input.mailbox;
  clearSessionControllerMailbox(mailbox, () => {});
  await captureSessionControllerSourceSettlement(input);
  expect(successor?.phase).toBe("preparing");
  expect(successor?.abortSignal.aborted).toBe(false);
  mailbox.wake();
  expect(findSessionControllerEntry(key, physical)?.mailbox).toBe(successor?.mailbox);
  if (successor) {
    retireSessionControllerInput(successor);
  }
});

it("rotates incarnation aliases while retaining exact late-writer lineage", async () => {
  const physical = target("/stores/rotation.sqlite", key, "old-id");
  await withSessionTurn(
    { sessionKey: key, sessionId: "old-id", target: physical },
    async (operation) => {
      if (!operation) {
        throw new Error("Missing operation");
      }
      operation.updateSessionId("new-id");
      const owner = getSessionControllerEntryForOperation(operation);
      expect(owner.aliases.has("old-id")).toBe(true);
      expect(owner.aliases.has("new-id")).toBe(true);
      expect(operation.captureOwnedSessionIds()).toEqual(new Set(["old-id", "new-id"]));
      expect(isSessionRunActive("old-id")).toBe(true);
      expect(resolveReplyRunForCurrentSessionId("old-id")).toEqual({
        kind: "one",
        operation,
      });
      expect(
        findSessionControllerEntry(
          "new-id",
          captureSessionTarget({ storeScope: physical.storeScope, sessionKey: "new-id" }),
        ),
      ).toBe(owner);
    },
  );
});

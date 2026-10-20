import { afterEach, expect, it, vi } from "vitest";
import { diagnosticLogger } from "../logging/diagnostic-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { ReplyRunAlreadyActiveError } from "./session-controller.contracts.js";
import {
  getSessionControllerSourceIdentity as sourceIdentity,
  resolveReplyRunForCurrentSessionId as resolveRun,
} from "./session-controller.identity.js";
import {
  resolveActiveReplyOperationForSessionId as resolveActiveRun,
  createReplyOperation,
  getSessionControllerOperation as getOperation,
  waitForSessionRunIdle,
} from "./session-controller.js";
import {
  captureSessionTarget as captureTarget,
  getCurrentSessionControllerClaim as currentClaim,
  runSessionMutation as mutate,
  startSessionControllerInterruption as interrupt,
  captureSessionControllerSettlement as controllerSettlement,
  bindSessionControllerTarget as bindTarget,
} from "./session-controller.lifecycle.js";
import {
  adoptSessionControllerSource as adoptSource,
  reserveSessionControllerSource as reserveSource,
  claimSessionControllerTask as claimTask,
  captureSessionControllerSourceSettlement as sourceSettlement,
  releaseSessionControllerClaim as releaseClaim,
  clearSessionControllerMailbox as clearMailbox,
  holdSessionControllerSourceWithdrawal as holdWithdrawal,
  abortSessionControllerInput as abortInput,
  retireSessionControllerInput as retireInput,
  retargetSessionControllerSource as retargetSource,
  updateSessionControllerSourcePolicy as updatePolicy,
  tryClaimSessionControllerTask as tryClaim,
} from "./session-controller.mailbox.js";
import { isSessionRunActive } from "./session-controller.queries.js";
import {
  findSessionControllerEntry as findEntry,
  getSessionControllerEntryForOperation as entryFor,
  sessionControllers,
} from "./session-controller.state.js";

const key = "agent:main:physical-identity";
const target = (storeScope: string, sessionKey = key, incarnation = "incarnation") =>
  captureTarget({ storeScope, sessionKey, incarnation });
function reserve(
  physical: ReturnType<typeof captureTarget>,
  options: Partial<Parameters<typeof reserveSource>[1]> = {},
) {
  return reserveSource(physical.sessionKey, {
    target: physical,
    policy: { mode: "followup" },
    ...options,
  });
}
function adopt(
  input: Parameters<typeof adoptSource>[0],
  physical: ReturnType<typeof captureTarget>,
  overrides: Partial<Parameters<typeof adoptSource>[1]> = {},
) {
  adoptSource(input, {
    protocolRunId: "settle-run",
    target: physical,
    policy: { mode: "followup" },
    adapter: {},
    ...overrides,
  });
}

function turn(physical: ReturnType<typeof captureTarget>) {
  return { sessionKey: physical.sessionKey, sessionId: physical.incarnation, target: physical };
}
const unboundTarget = (storeScope: string) => captureTarget({ storeScope, sessionKey: key });
function releaseAndWait(claim: Awaited<ReturnType<typeof claimTask>>) {
  releaseClaim(claim);
  return claim.settlement.promise;
}
function heldTurn(physical: ReturnType<typeof captureTarget>) {
  const entered = createDeferredCore();
  const done = createDeferredCore();
  const run = withSessionTurn(turn(physical), async (operation) => {
    expect(operation?.key).toBe(key);
    entered.resolve();
    await done.promise;
  });
  return { entered: entered.promise, done: done.resolve, run };
}
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
      clearMailbox(mailbox, () => {});
      if (mailbox.claim) {
        receipts.push(mailbox.claim.settlement.promise);
        releaseClaim(mailbox.claim);
      }
    }
  }
  await Promise.allSettled(receipts);
});

it("treats equal active identities in two stores as busy and mutates only the selected owner", async () => {
  const a = target("/stores/a.sqlite");
  const b = target("/stores/b.sqlite");
  const runA = heldTurn(a);
  const runB = heldTurn(b);
  await Promise.all([runA.entered, runB.entered]);
  const ownerA = getOperation(key, a);
  const ownerB = getOperation(key, b);
  expect(ownerA).toBeDefined();
  expect(ownerB).toBeDefined();
  expect(ownerA).not.toBe(ownerB);
  using warning = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
  expect(resolveRun("incarnation")).toEqual({
    kind: "ambiguous",
    operations: [ownerA, ownerB],
  });
  expect(isSessionRunActive("incarnation")).toBe(true);
  for (const lookup of [
    () => resolveActiveRun("incarnation"),
    () =>
      createReplyOperation({ sessionKey: key, sessionId: "incarnation", resetTriggered: false }),
    () => getOperation(key),
  ]) {
    expect(lookup).toThrow(ReplyRunAlreadyActiveError);
  }
  const entryIds = [ownerA, ownerB]
    .map((operation) => entryFor(operation!).id)
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
  const mutation = mutate({
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
  runA.done();
  await Promise.all([runA.run, mutation]);
  await Promise.resolve();
  expect(idle).toBe(false);
  expect(ownerB?.abortSignal.aborted).toBe(false);
  runB.done();
  await runB.run;
  await expect(idleReceipt).resolves.toBe(true);
});

it("aliases of one physical incarnation share the same selector", async () => {
  const first = reserve(target("/stores/aliases.sqlite"));
  const aliasKey = "agent:main:alias";
  const second = reserve(target("/stores/aliases.sqlite", aliasKey));
  expect(second.mailbox).toBe(first.mailbox);
  const claim = await claimTask(first, () => {});
  const selected = vi.fn();
  const next = claimTask(second, selected);
  expect(selected).not.toHaveBeenCalled();
  releaseClaim(claim);
  const nextClaim = await next;
  expect(selected).toHaveBeenCalledOnce();
  await releaseAndWait(nextClaim);
});

it("keeps nested raw-key turns owned by separate agents in one physical store", async () => {
  const agentTarget = (agentId: string) =>
    captureTarget({
      storeScope: "/stores/shared-global.sqlite",
      sessionKey: "global",
      incarnation: "incarnation",
      agentId,
    });
  const outerTarget = agentTarget("main");
  const nestedTarget = agentTarget("other");
  await withSessionTurn(turn(outerTarget), async (outer) => {
    expect(outer).toBeDefined();
    expect(() => outer!.updateSessionKey("global", "other")).toThrow(
      "Changing agent owner requires matching destination admission",
    );
    expect(outer!.agentId).toBe("main");
    await withSessionTurn(turn(nestedTarget), async (nested) => {
      expect(nested).toBeDefined();
      expect(nested).not.toBe(outer);
      expect(getOperation("global", outerTarget)).toBe(outer);
      expect(getOperation("global", nestedTarget)).toBe(nested);
    });
    await expect(
      withSessionTurn({ ...turn(nestedTarget), replyOperation: outer }, async () => {}),
    ).rejects.toThrow("does not match its session controller admission");
    expect(() => bindTarget(outer!, nestedTarget)).toThrow(
      "Cannot move a controller between agent owners",
    );
    expect(entryFor(outer!).target).toBe(outerTarget);
  });
});

it("deduplicates one reserved delivery identity and rejects conflicting reuse", () => {
  const physical = target("/stores/reservation.sqlite");
  const reservation = {
    reservationId: "subagent-completion:run-1:0",
    protocolRunId: "run-1",
  };
  const first = reserve(physical, reservation);
  const second = reserve(physical, reservation);

  expect(second).toBe(first);
  expect(first.mailbox.entries).toEqual([first]);
  expect(() => reserve(physical, { ...reservation, protocolRunId: "different-run" })).toThrow(
    "different delivery",
  );
  expect(() => reserve(physical, { ...reservation, policy: { mode: "steer" } })).toThrow(
    "different delivery",
  );
  expect(() => reserve(target("/stores/other.sqlite"), reservation)).toThrow("different delivery");
});

it("adopts only the exact unclaimed reserved source", async () => {
  const physical = target("/stores/rpc-adoption.sqlite");
  const adapter = {};
  const input = reserve(unboundTarget(physical.storeScope), {
    reservationId: "subagent-settle:batch:0",
  });
  expect(() => adopt(input, target("/stores/foreign.sqlite"), { adapter })).toThrow(
    "foreign or claimed",
  );
  adopt(input, physical, { adapter });
  expect(sourceIdentity(input)).toMatchObject({
    sessionKey: key,
    sessionId: "incarnation",
  });
  expect(input).toMatchObject({ protocolRunId: "settle-run", custody: { rpcAdopted: true } });
  expect(input.sourceAdapter).toBe(adapter);
  expect(() => adopt(input, physical, { adapter })).toThrow("foreign or claimed");

  const claimedTarget = target("/stores/rpc-claimed.sqlite");
  const claimed = reserve(claimedTarget);
  const claim = await claimTask(claimed, () => {});
  expect(() => adopt(claimed, claimedTarget, { protocolRunId: "claimed-run" })).toThrow(
    "foreign or claimed",
  );
  await releaseAndWait(claim);
});

it.each(
  (["signal", "authority"] as const).flatMap((binding) =>
    [false, true].map((alreadyAborted) => ({ binding, alreadyAborted })),
  ),
)(
  "binds adopted $binding cancellation (alreadyAborted=$alreadyAborted)",
  async ({ binding, alreadyAborted }) => {
    const physical = target("/stores/adopted-cancellation.sqlite");
    const input = reserve(physical);
    const originalSignal = input.abortSignal;
    const cancellation = new AbortController();
    const reason = new Error("adopted source cancelled");
    if (alreadyAborted) {
      cancellation.abort(reason);
    }
    adopt(input, physical, {
      protocolRunId: "adopted-cancellation",
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
      await expect(claimTask(input, start)).rejects.toBe(reason);
      expect(start).not.toHaveBeenCalled();
    } finally {
      retireInput(input);
      await input.settlement.promise;
    }
  },
);

it("moves one unbound command source into target ordering without replacing its receipt", async () => {
  const source = reserve(target("/stores/command.sqlite", key, "command-source"), {
    protocolRunId: " exact command id ",
  });
  const receipt = sourceSettlement(source);
  const originalMailbox = source.mailbox;
  expect(() => retargetSource(source, target("/stores/other.sqlite"))).toThrow("physical store");
  expect(source.mailbox).toBe(originalMailbox);
  expect(originalMailbox.entries).toContain(source);
  const destination = target("/stores/command.sqlite", key + ":target", "target-row");
  const older = reserve(destination);
  retargetSource(source, destination);
  expect(sourceSettlement(source)).toBe(receipt);
  expect(source.protocolRunId).toBe(" exact command id ");
  expect(findEntry(key)).toBeUndefined();
  expect(tryClaim(source)).toBeUndefined();
  updatePolicy(source, { mode: "interrupt" });
  const priority = tryClaim(source);
  expect(priority?.inputs).toEqual([source]);
  expect(() => retargetSource(source, target("/stores/other.sqlite"))).toThrow();
  const released = releaseAndWait(priority!);
  await receipt;
  await released;
  const next = await claimTask(older, () => {});
  expect(next.inputs).toEqual([older]);
  await releaseAndWait(next);
});

it("adopts a real incarnation under the same unbound outer claim and borrows required maintenance", async () => {
  const physical = unboundTarget("/stores/fresh.sqlite");
  await withSessionTurn({ sessionKey: key, target: physical }, async (unbound) => {
    expect(unbound).toBeUndefined();
    const claim = currentClaim();
    expect(claim?.operation).toBeUndefined();
    await withSessionTurn(
      { sessionKey: key, sessionId: "created-row", target: physical },
      async (operation) => {
        expect(operation?.sessionId).toBe("created-row");
        expect(currentClaim()).toBe(claim);
        expect(claim?.operation).toBe(operation);
        if (!operation) {
          throw new Error("Missing adopted operation");
        }
        for (const phase of ["preflight_compacting", "memory_flushing"] as const) {
          operation.setPhase(phase);
          await withSessionTurn(
            { ...turn(physical), sessionId: "created-row", replyOperation: operation },
            async (maintenance) => expect(maintenance).toBe(operation),
          );
        }
      },
    );
    expect(claim?.operation?.result).toBeNull();
  });
});

it("reuses an early input and cancels reset preparation without completing its live callback", async () => {
  const physical = unboundTarget("/stores/preparing.sqlite");
  const input = reserve(physical);
  const started = createDeferredCore();
  const release = createDeferredCore();
  const work = withSessionTurn(
    { sessionKey: key, target: physical, controllerInput: input },
    async (operation, signal) => {
      expect(operation).toBeUndefined();
      expect(currentClaim()?.inputs).toEqual([input]);
      expect(input.mailbox.entries).toEqual([input]);
      started.resolve();
      await release.promise;
      expect(signal.aborted).toBe(true);
    },
  );
  await started.promise;
  const interruption = interrupt({ target: physical });
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
  const input = reserve(physical, {
    adapter: { onSettled: () => cleanup.promise },
  });
  const injection = createDeferredCore<boolean>();
  const settle = vi.fn(injection.resolve);
  input.phase = "injecting";
  input.injection = { predecessor: Promise.resolve(true), settled: injection.promise, settle };
  clearMailbox(input.mailbox, () => {});
  expect(settle).not.toHaveBeenCalled();
  expect(input.mailbox.entries).toContain(input);
  const fresh = reserve(physical);
  expect(fresh.abortSignal.aborted).toBe(false);
  const started = vi.fn();
  const queued = claimTask(fresh, started);
  expect(started).not.toHaveBeenCalled();
  const receipt = controllerSettlement({ target: physical });
  let ended = false;
  void sourceSettlement(input).then(() => {
    ended = true;
  });
  injection.resolve(true);
  input.injection = undefined;
  input.phase = "waiting";
  retireInput(input);
  await Promise.resolve();
  expect(ended).toBe(false);
  expect(started).not.toHaveBeenCalled();
  cleanup.resolve();
  await sourceSettlement(input);
  const claim = await queued;
  expect(started).toHaveBeenCalledOnce();
  releaseClaim(claim);
  await receipt;
});

it("retains claimed source adoption until the callback settles", async () => {
  const input = reserve(target("/stores/adoption.sqlite"));
  const claim = await claimTask(input, () => {});
  const adoption = createDeferredCore();
  input.custody.adopting = adoption.promise;
  clearMailbox(input.mailbox, () => {});
  releaseClaim(claim);
  expect(claim.released).toBe(false);
  expect(input.mailbox.claim).toBe(claim);
  input.custody.adopting = undefined;
  adoption.resolve();
  await claim.settlement.promise;
  expect(input.phase).toBe("consumed");
});

it("cancels atomically while holding selection and refuses unavailable withdrawal", async () => {
  const input = reserve(target("/stores/withdraw.sqlite"));
  const hold = holdWithdrawal(input);
  const selected = vi.fn();
  const pending = claimTask(input, selected);
  const reason = new Error("Source cancelled by request");
  const rejection = expect(pending).rejects.toBe(reason);
  expect(abortInput(input)).toBe(false);
  expect(hold.cancel(() => {}, reason)).toBe(true);
  hold();
  await rejection;
  expect(selected).not.toHaveBeenCalled();
  expect(() => holdWithdrawal(input)).toThrow(/unavailable/);
});

it("stale disposal cannot delete a successor created by settlement callbacks", async () => {
  const physical = target("/stores/reentrant.sqlite");
  let successor: ReturnType<typeof reserveSource> | undefined;
  const input = reserve(physical, {
    adapter: {
      onSettled: () => {
        successor = reserve(physical);
      },
    },
  });
  const mailbox = input.mailbox;
  clearMailbox(mailbox, () => {});
  await sourceSettlement(input);
  expect(successor).toMatchObject({ phase: "preparing", abortSignal: { aborted: false } });
  mailbox.wake();
  expect(findEntry(key, physical)?.mailbox).toBe(successor?.mailbox);
  if (successor) {
    retireInput(successor);
  }
});

it("rotates incarnation aliases while retaining exact late-writer lineage", async () => {
  const physical = target("/stores/rotation.sqlite", key, "old-id");
  await withSessionTurn(turn(physical), async (operation) => {
    if (!operation) {
      throw new Error("Missing operation");
    }
    operation.updateSessionId("new-id");
    const owner = entryFor(operation);
    expect([...owner.aliases]).toEqual(expect.arrayContaining(["old-id", "new-id"]));
    expect(operation.captureOwnedSessionIds()).toEqual(new Set(["old-id", "new-id"]));
    expect(isSessionRunActive("old-id")).toBe(true);
    expect(resolveRun("old-id")).toEqual({ kind: "one", operation });
    expect(
      findEntry("new-id", captureTarget({ storeScope: physical.storeScope, sessionKey: "new-id" })),
    ).toBe(owner);
  });
});

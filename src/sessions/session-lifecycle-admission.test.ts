// Tests lifecycle/work admission ordering across canonical keys and backing ids.
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
  consumeSessionWorkAdmissionHandoff,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
  hasOnlySessionLifecycleMutationKindActive,
  interruptSessionWorkAdmissions,
  isCompetingSessionWorkAdmissionActive,
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "./session-lifecycle-admission.js";

it("validates default admission once after earlier store writes", async () => {
  const scope = "store-default-validation-order";
  const entered = createDeferred();
  const releaseWriter = createDeferred();
  let value = "before";
  const observations: string[] = [];
  const writer = runExclusiveSessionStoreWrite(scope, async () => {
    entered.resolve();
    await releaseWriter.promise;
    value = "after";
  });
  await entered.promise;
  const pending = beginSessionWorkAdmission({
    scope,
    identities: ["session-default-validation-order"],
    assertAllowed: () => {
      observations.push(value);
    },
  });
  try {
    await waitForImmediate();
    expect(observations).toEqual([]);
  } finally {
    releaseWriter.resolve();
    (await pending).release();
    await writer;
  }
  expect(observations).toEqual(["after"]);
});

it("atomically hands admitted work across an interrupted RPC boundary", async () => {
  const scope = "store-rpc-handoff";
  const identities = ["agent:main:main", "session-rpc-handoff"];
  const admission = await beginSessionWorkAdmission({
    scope,
    identities,
    assertAllowed: () => {},
  });
  const handoffId = admission.createHandoff();
  const mutationStarted = createDeferred();
  let mutationRan = false;
  const mutation = runExclusiveSessionLifecycleMutation("patch", {
    scope,
    identities,
    prepare: async () => {
      mutationStarted.resolve();
      expect(await interruptSessionWorkAdmissions({ scope, identities, timeoutMs: 1_000 })).toBe(
        true,
      );
    },
    run: async () => {
      mutationRan = true;
    },
  });
  await mutationStarted.promise;
  let interrupted = false;
  const adopted = consumeSessionWorkAdmissionHandoff({
    handoffId,
    scope,
    identities,
    onInterrupt: () => {
      interrupted = true;
    },
  });

  try {
    expect(adopted).toBe(admission);
    expect(interrupted).toBe(true);
    expect(cancelSessionWorkAdmissionHandoff(handoffId)).toBe(false);
    expect(mutationRan).toBe(false);
  } finally {
    adopted?.release();
    admission.release();
    await mutation;
  }
  expect(mutationRan).toBe(true);
});

it("keeps an admission handoff bound to its original identities", async () => {
  const admission = await beginSessionWorkAdmission({
    scope: "store-bound-handoff",
    identities: ["agent:main:main", "session-bound-handoff"],
    assertAllowed: () => {},
  });
  const handoffId = admission.createHandoff();

  expect(
    consumeSessionWorkAdmissionHandoff({
      handoffId,
      scope: "store-bound-handoff",
      identities: ["agent:main:other", "session-bound-handoff"],
    }),
  ).toBeUndefined();
  expect(cancelSessionWorkAdmissionHandoff(handoffId)).toBe(true);
  expect(isSessionWorkAdmissionActive("store-bound-handoff", ["session-bound-handoff"])).toBe(
    false,
  );
});

it("finalizes a lifecycle mutation when its run throws", async () => {
  const runError = new Error("lifecycle run failed");
  const finalize = vi.fn(async () => {});

  await expect(
    runExclusiveSessionLifecycleMutation("patch", {
      scope: "store-finalize-run-error",
      identities: ["session-finalize-run-error"],
      run: async () => {
        throw runError;
      },
      finalize,
    }),
  ).rejects.toBe(runError);
  expect(finalize).toHaveBeenCalledOnce();
});

it("releases lifecycle state when finalization throws", async () => {
  const target = { scope: "store-finalize-error", identities: ["session-finalize-error"] };
  const finalizeError = new Error("lifecycle finalizer failed");

  await expect(
    runExclusiveSessionLifecycleMutation("patch", {
      ...target,
      run: async () => {},
      finalize: async () => {
        throw finalizeError;
      },
    }),
  ).rejects.toBe(finalizeError);
  expect(isSessionLifecycleMutationActive(target.scope, target.identities)).toBe(false);
  await expect(
    runExclusiveSessionLifecycleMutation("patch", { ...target, run: async () => "next" }),
  ).resolves.toBe("next");
});

it("counts a cross-store lifecycle mutation once and fences every target", async () => {
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation("patch", {
    targets: [
      {
        scope: "store-cross-count-b",
        identities: ["agent:work:main", "session-cross-count-b"],
      },
      {
        scope: "store-cross-count-a",
        identities: ["agent:main:main", "session-cross-count-a"],
      },
      {
        scope: "store-cross-count-a",
        identities: ["session-cross-count-a", undefined],
      },
    ],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  try {
    expect(getActiveSessionLifecycleMutationCount()).toBe(1);
    expect(isSessionLifecycleMutationActive("store-cross-count-a", ["agent:main:main"])).toBe(true);
    expect(isSessionLifecycleMutationActive("store-cross-count-b", ["session-cross-count-b"])).toBe(
      true,
    );
    expect(isSessionLifecycleMutationActive("store-cross-count-b", ["agent:main:main"])).toBe(
      false,
    );
  } finally {
    releaseMutation.resolve();
    await mutation;
  }

  expect(getActiveSessionLifecycleMutationCount()).toBe(0);
  expect(isSessionLifecycleMutationActive("store-cross-count-a", ["session-cross-count-a"])).toBe(
    false,
  );
  expect(isSessionLifecycleMutationActive("store-cross-count-b", ["session-cross-count-b"])).toBe(
    false,
  );
});

it("serializes opposite-direction cross-store lifecycle mutations", async () => {
  const main = {
    scope: "store-cross-order-a",
    identities: ["agent:main:main", "session-cross-order-a"],
  };
  const work = {
    scope: "store-cross-order-b",
    identities: ["agent:work:main", "session-cross-order-b"],
  };
  let activeMutations = 0;
  let maximumActiveMutations = 0;
  let completedMutations = 0;

  await Promise.all(
    Array.from({ length: 48 }, async (_, index) =>
      runExclusiveSessionLifecycleMutation("patch", {
        targets: index % 2 === 0 ? [main, work] : [work, main],
        run: async () => {
          activeMutations += 1;
          maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations);
          try {
            await Promise.resolve();
            completedMutations += 1;
          } finally {
            activeMutations -= 1;
          }
        },
      }),
    ),
  );

  expect(completedMutations).toBe(48);
  expect(maximumActiveMutations).toBe(1);
  expect(activeMutations).toBe(0);
  expect(getActiveSessionLifecycleMutationCount()).toBe(0);
});

it("interrupts admitted work in both stores before a cross-store mutation", async () => {
  const mainTarget = {
    scope: "store-cross-interrupt-a",
    identities: ["agent:main:main", "session-cross-interrupt-a"],
  };
  const workTarget = {
    scope: "store-cross-interrupt-b",
    identities: ["agent:work:main", "session-cross-interrupt-b"],
  };
  let mainInterrupted = false;
  let workInterrupted = false;
  const mainAdmission = await beginSessionWorkAdmission({
    ...mainTarget,
    assertAllowed: () => {},
    onInterrupt: () => {
      mainInterrupted = true;
      mainAdmission.release();
    },
  });
  const workAdmission = await beginSessionWorkAdmission({
    ...workTarget,
    assertAllowed: () => {},
    onInterrupt: () => {
      workInterrupted = true;
      workAdmission.release();
    },
  });

  try {
    await runExclusiveSessionLifecycleMutation("drain", {
      targets: [workTarget, mainTarget],
      prepare: async () => {
        const interrupted = await Promise.all([
          interruptSessionWorkAdmissions({ ...mainTarget, timeoutMs: 1_000 }),
          interruptSessionWorkAdmissions({ ...workTarget, timeoutMs: 1_000 }),
        ]);
        expect(interrupted).toEqual([true, true]);
      },
      run: async () => {
        expect(mainInterrupted).toBe(true);
        expect(workInterrupted).toBe(true);
        expect(isSessionWorkAdmissionActive(mainTarget.scope, mainTarget.identities)).toBe(false);
        expect(isSessionWorkAdmissionActive(workTarget.scope, workTarget.identities)).toBe(false);
      },
    });
  } finally {
    mainAdmission.release();
    workAdmission.release();
  }
});

it("cancels an opposite-direction cross-store mutation before activation", async () => {
  const main = {
    scope: "store-cross-cancel-a",
    identities: ["agent:main:main", "session-cross-cancel-a"],
  };
  const work = {
    scope: "store-cross-cancel-b",
    identities: ["agent:work:main", "session-cross-cancel-b"],
  };
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const first = runExclusiveSessionLifecycleMutation("patch", {
    targets: [main, work],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  const controller = new AbortController();
  const abortError = new Error("cancel queued cross-store lifecycle mutation");
  let cancelledMutationRan = false;
  const cancelled = runExclusiveSessionLifecycleMutation("patch", {
    targets: [work, main],
    signal: controller.signal,
    run: async () => {
      cancelledMutationRan = true;
    },
  });
  controller.abort(abortError);

  try {
    await expect(cancelled).rejects.toBe(abortError);
  } finally {
    releaseMutation.resolve();
    await first;
  }

  expect(cancelledMutationRan).toBe(false);
  expect(getActiveSessionLifecycleMutationCount()).toBe(0);
});

it("rejects an admission that resumes after suspension closes the async gap", async () => {
  resetGatewayWorkAdmission();
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation("patch", {
    scope: "store-suspend-race",
    identities: ["session-suspend-race", "backing-suspend-race"],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;
  expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0);

  const admission = beginSessionWorkAdmission({
    scope: "store-suspend-race",
    identities: ["session-suspend-race", "backing-suspend-race"],
    assertAllowed: () => {},
  });
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  releaseMutation.resolve();
  await mutation;
  expect(getActiveSessionLifecycleMutationCount()).toBe(0);

  await expect(admission).rejects.toMatchObject({ name: "GatewayDrainingError" });
  expect(getActiveSessionWorkAdmissionCount()).toBe(0);
  suspension?.release();
  resetGatewayWorkAdmission();
});

it("lets an admitted root enter session work while suspension preparation refuses new roots", async () => {
  resetGatewayWorkAdmission();
  const continueRoot = createDeferred();
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  const active = root?.run(async () => {
    await continueRoot.promise;
    const admission = await beginSessionWorkAdmission({
      scope: "store-admitted-root",
      identities: ["session-admitted-root"],
      assertAllowed: () => {},
    });
    admission.release();
  });
  const suspension = tryBeginGatewaySuspendAdmission(() => {});

  try {
    continueRoot.resolve();
    await expect(active).resolves.toBeUndefined();
    await expect(
      beginSessionWorkAdmission({
        scope: "store-new-root",
        identities: ["session-new-root"],
        assertAllowed: () => {},
      }),
    ).rejects.toMatchObject({ name: "GatewayDrainingError" });
  } finally {
    suspension?.rollback();
    root?.release();
    resetGatewayWorkAdmission();
  }
});

it.each([false, true])(
  "excludes its own lease during revalidation while retaining competing work (%s)",
  async (hasCompetingWork) => {
    const target = {
      scope: "store-revalidation-owner",
      identities: ["agent:main:main", "session-revalidation-owner"],
    };
    const competing = hasCompetingWork
      ? await beginSessionWorkAdmission({ ...target, assertAllowed: () => {} })
      : undefined;
    try {
      const admission = await beginSessionWorkAdmission({
        ...target,
        assertAllowed: () => {},
        revalidateAllowed: async () => {
          await Promise.resolve();
          expect(isSessionWorkAdmissionActive(target.scope, target.identities)).toBe(true);
          expect(isCompetingSessionWorkAdmissionActive(target.scope, target.identities)).toBe(
            hasCompetingWork,
          );
        },
      });
      try {
        expect(isCompetingSessionWorkAdmissionActive(target.scope, target.identities)).toBe(true);
      } finally {
        admission.release();
      }
      expect(isSessionWorkAdmissionActive(target.scope, target.identities)).toBe(hasCompetingWork);
    } finally {
      competing?.release();
    }
  },
);

it("admits an independent session while revalidating a conflicting writer's authority", async () => {
  const scope = "store-keyed-admission";
  const blockedKey = "agent:main:blocked";
  const independentKey = "agent:main:independent";
  const releaseWriter = createDeferred();
  const initialValidation = createDeferred();
  const independentEntered = createDeferred();
  const releaseIndependent = createDeferred();
  let allowed = true;
  const validateBlocked = vi.fn(() => {
    if (!allowed) {
      throw new Error("session authority revoked");
    }
  });
  const writer = runExclusiveSessionStoreWrite(
    scope,
    async () => {
      await releaseWriter.promise;
      allowed = false;
    },
    { identities: [blockedKey] },
  );
  const blocked = beginSessionWorkAdmission({
    scope,
    identities: [blockedKey, "blocked-id"],
    storeWriterIdentities: [blockedKey],
    assertAllowed: () => {
      validateBlocked();
      initialValidation.resolve();
    },
    revalidateAllowed: validateBlocked,
  });
  const blockedOutcome = expect(blocked).rejects.toThrow("session authority revoked");
  await initialValidation.promise;
  const independent = beginSessionWorkAdmission({
    scope,
    identities: [independentKey, "independent-id"],
    storeWriterIdentities: [independentKey],
    assertAllowed: () => {},
    revalidateAllowed: async () => {
      independentEntered.resolve();
      await releaseIndependent.promise;
    },
  });

  try {
    await independentEntered.promise;
    expect(validateBlocked).toHaveBeenCalledTimes(1);
    releaseWriter.resolve();
    await writer;
    await blockedOutcome;
    expect(validateBlocked).toHaveBeenCalledTimes(2);
    expect(isSessionWorkAdmissionActive(scope, [blockedKey])).toBe(false);
    expect(isSessionWorkAdmissionActive(scope, [independentKey])).toBe(true);
    releaseIndependent.resolve();
    const lease = await independent;
    lease.release();
  } finally {
    releaseWriter.resolve();
    releaseIndependent.resolve();
    const results = await Promise.allSettled([blocked, independent]);
    for (const result of results) {
      if (result.status === "fulfilled") {
        result.value.release();
      }
    }
    await Promise.allSettled([writer, blockedOutcome]);
  }
});

it("serializes lifecycle mutation and work admission across identity aliases", async () => {
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation("patch", {
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  let admitted = false;
  const admission = beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["session-1"],
    assertAllowed: () => {
      admitted = true;
    },
  });
  try {
    await mutationStarted.promise;
    expect(admitted).toBe(false);

    releaseMutation.resolve();
    await mutation;
    await admission;
    expect(admitted).toBe(true);
    expect(isSessionWorkAdmissionActive("store-a", ["agent:main:child", "session-1"])).toBe(true);
  } finally {
    releaseMutation.resolve();
    await mutation;
    (await admission).release();
  }
  expect(isSessionWorkAdmissionActive("store-a", ["session-1"])).toBe(false);
});

it("tracks the active lifecycle mutation kind across identity aliases", async () => {
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation("compact", {
    scope: "store-kind",
    identities: ["agent:main:child", "session-kind"],
    kind: "compaction",
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  expect(
    hasOnlySessionLifecycleMutationKindActive("store-kind", ["session-kind"], "compaction"),
  ).toBe(true);
  expect(
    hasOnlySessionLifecycleMutationKindActive("store-other", ["session-kind"], "compaction"),
  ).toBe(false);

  releaseMutation.resolve();
  await mutation;
  expect(
    hasOnlySessionLifecycleMutationKindActive("store-kind", ["session-kind"], "compaction"),
  ).toBe(false);
});

it("keeps identical session keys isolated by store", async () => {
  const admissionLease = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["global", "session-a"],
    assertAllowed: () => {},
  });

  try {
    expect(isSessionWorkAdmissionActive("store-a", ["global"])).toBe(true);
    expect(isSessionWorkAdmissionActive("store-b", ["global"])).toBe(false);
    let storeBMutationRan = false;
    await runExclusiveSessionLifecycleMutation("patch", {
      scope: "store-b",
      identities: ["global"],
      run: async () => {
        storeBMutationRan = true;
      },
    });
    expect(storeBMutationRan).toBe(true);
  } finally {
    admissionLease.release();
  }
});

it("cancels work admission waiting behind a lifecycle mutation", async () => {
  const mutationPrepared = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation("patch", {
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    prepare: async () => {
      mutationPrepared.resolve();
      await releaseMutation.promise;
    },
    run: async () => {},
  });
  await mutationPrepared.promise;

  const controller = new AbortController();
  const abortError = new Error("reset interrupted admission");
  const admission = beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["session-1"],
    signal: controller.signal,
    assertAllowed: () => {},
  });
  controller.abort(abortError);

  await expect(admission).rejects.toBe(abortError);
  releaseMutation.resolve();
  await mutation;
});

it("preserves the initiating admission across a queued lifecycle mutation", async () => {
  let selfInterrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    assertAllowed: () => {},
    onInterrupt: () => {
      selfInterrupted = true;
    },
  });
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const first = runExclusiveSessionLifecycleMutation("patch", {
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    },
  });
  await firstStarted.promise;

  let initiatingAdmissionExcluded = false;
  const queued = admission.run(
    async () =>
      await runExclusiveSessionLifecycleMutation("drain", {
        scope: "store-a",
        identities: ["agent:main:child", "session-1"],
        prepare: async () => {
          initiatingAdmissionExcluded = await interruptSessionWorkAdmissions({
            scope: "store-a",
            identities: ["agent:main:child", "session-1"],
            timeoutMs: 1,
          });
        },
        run: async () => {},
      }),
  );

  try {
    releaseFirst.resolve();
    await first;
    await queued;
    expect(initiatingAdmissionExcluded).toBe(true);
    expect(selfInterrupted).toBe(false);
  } finally {
    releaseFirst.resolve();
    admission.release();
    await Promise.allSettled([first, queued]);
  }
});

it("bounds interruption waits for non-cooperative work", async () => {
  const admissionLease = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    assertAllowed: () => {},
    onInterrupt: () => {},
  });

  try {
    await expect(
      interruptSessionWorkAdmissions({
        scope: "store-a",
        identities: ["session-1"],
        timeoutMs: 1,
      }),
    ).resolves.toBe(false);
  } finally {
    admissionLease.release();
  }
});

it("shares lifecycle coordination across duplicate module instances", async () => {
  const first = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-lifecycle-a",
  );
  const second = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-lifecycle-b",
  );
  let releaseLease = () => {};
  let interrupted = false;
  const lease = await first.beginSessionWorkAdmission({
    scope: "store-duplicate",
    identities: ["agent:main:child", "session-duplicate"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
      releaseLease();
    },
  });
  releaseLease = lease.release;

  try {
    expect(second.isSessionWorkAdmissionActive("store-duplicate", ["session-duplicate"])).toBe(
      true,
    );
    await expect(
      second.interruptSessionWorkAdmissions({
        scope: "store-duplicate",
        identities: ["agent:main:child"],
        timeoutMs: 50,
      }),
    ).resolves.toBe(true);
    expect(interrupted).toBe(true);
    expect(first.isSessionWorkAdmissionActive("store-duplicate", ["session-duplicate"])).toBe(
      false,
    );
  } finally {
    lease.release();
  }
});

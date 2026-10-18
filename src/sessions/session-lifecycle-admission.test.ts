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
  beginSessionEffect as beginAdmission,
  cancelSessionEffectHandoff as cancelHandoff,
  consumeSessionEffectHandoff as consumeHandoff,
  getSessionMutationCount,
  getSessionControllerWorkCount,
  hasOnlySessionMutationKindActive as onlyKindActive,
  interruptSessionControllerEffects as interrupt,
  isCompetingSessionControllerWorkActive as competingActive,
  isSessionMutationActive as mutationActive,
  isSessionControllerWorkActive as workActive,
  runSessionMutation as mutate,
} from "./session-controller.lifecycle.js";

type Target = { scope: string; identities: (string | undefined)[] };
function target(scope: string, ...identities: (string | undefined)[]): Target {
  return { scope, identities };
}
function admit(params: Parameters<typeof beginAdmission>[0]) {
  return beginAdmission({ assertAllowed: () => {}, ...params });
}
function holdMutation(
  owner: Target | { targets: Target[] },
  options: { kind?: "compaction"; prepare?: boolean } = {},
) {
  const started = createDeferred();
  const release = createDeferred();
  const wait = async () => {
    started.resolve();
    await release.promise;
  };
  const mutation = mutate({
    ...owner,
    kind: options.kind,
    run: options.prepare ? async () => {} : wait,
    ...(options.prepare ? { prepare: wait } : {}),
  });
  return { started: started.promise, release: release.resolve, mutation };
}
const childTarget = { scope: "store-a", identities: ["agent:main:child", "session-1"] };

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
  const pending = admit({
    scope,
    identities: ["session-default-validation-order"],
    assertAllowed: () => void observations.push(value),
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
  const admission = await admit({ scope, identities });
  const handoffId = admission.createHandoff();
  const mutationStarted = createDeferred();
  const run = vi.fn(async () => {});
  const mutation = mutate({
    scope,
    identities,
    prepare: async () => {
      mutationStarted.resolve();
      expect(await interrupt({ scope, identities, timeoutMs: 1_000 })).toBe(true);
    },
    run,
  });
  await mutationStarted.promise;
  const onInterrupt = vi.fn();
  const adopted = consumeHandoff({ handoffId, scope, identities, onInterrupt });

  try {
    expect(adopted).toBe(admission);
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(cancelHandoff(handoffId)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  } finally {
    adopted?.release();
    admission.release();
    await mutation;
  }
  expect(run).toHaveBeenCalledOnce();
});

it("keeps an admission handoff bound to its original identities", async () => {
  const admission = await admit(
    target("store-bound-handoff", "agent:main:main", "session-bound-handoff"),
  );
  const handoffId = admission.createHandoff();

  expect(
    consumeHandoff({
      handoffId,
      scope: "store-bound-handoff",
      identities: ["agent:main:other", "session-bound-handoff"],
    }),
  ).toBeUndefined();
  expect(cancelHandoff(handoffId)).toBe(true);
  expect(workActive("store-bound-handoff", ["session-bound-handoff"])).toBe(false);
});

it("keeps a same-identity mutation queued until finalization completes", async () => {
  const owner = { scope: "store-finalize-order", identities: ["session-finalize-order"] };
  const finalizeStarted = createDeferred();
  const releaseFinalize = createDeferred();
  const secondRun = vi.fn(async () => {});
  const first = mutate({
    ...owner,
    run: async () => {},
    finalize: async () => {
      finalizeStarted.resolve();
      await releaseFinalize.promise;
    },
  });
  await finalizeStarted.promise;
  const second = mutate({ ...owner, run: secondRun });
  try {
    await waitForImmediate();
    expect(secondRun).not.toHaveBeenCalled();
  } finally {
    releaseFinalize.resolve();
    await Promise.all([first, second]);
  }
  expect(secondRun).toHaveBeenCalledOnce();
});

it.each(["run", "finalize"] as const)("releases lifecycle state when %s throws", async (phase) => {
  const owner = target(`store-${phase}-error`, "session-finalize-error");
  const error = new Error(`lifecycle ${phase} failed`);
  const fail = async () => {
    throw error;
  };
  const finalize = vi.fn(phase === "finalize" ? fail : async () => {});
  await expect(
    mutate({
      ...owner,
      run: phase === "run" ? fail : async () => {},
      finalize,
    }),
  ).rejects.toBe(error);
  expect(finalize).toHaveBeenCalledOnce();
  expect(mutationActive(owner.scope, owner.identities)).toBe(false);
  await expect(mutate({ ...owner, run: async () => "next" })).resolves.toBe("next");
});

it("counts a cross-store lifecycle mutation once and fences every target", async () => {
  const held = holdMutation({
    targets: [
      target("store-cross-count-b", "agent:work:main", "session-cross-count-b"),
      target("store-cross-count-a", "agent:main:main", "session-cross-count-a"),
      target("store-cross-count-a", "session-cross-count-a", undefined),
    ],
  });
  await held.started;

  try {
    expect(getSessionMutationCount()).toBe(1);
    expect(mutationActive("store-cross-count-a", ["agent:main:main"])).toBe(true);
    expect(mutationActive("store-cross-count-b", ["session-cross-count-b"])).toBe(true);
    expect(mutationActive("store-cross-count-b", ["agent:main:main"])).toBe(false);
  } finally {
    held.release();
    await held.mutation;
  }

  expect(getSessionMutationCount()).toBe(0);
  expect(mutationActive("store-cross-count-a", ["session-cross-count-a"])).toBe(false);
  expect(mutationActive("store-cross-count-b", ["session-cross-count-b"])).toBe(false);
});

it("serializes opposite-direction cross-store lifecycle mutations", async () => {
  const main = target("store-cross-order-a", "agent:main:main", "session-cross-order-a");
  const work = target("store-cross-order-b", "agent:work:main", "session-cross-order-b");
  let activeMutations = 0;
  let maximumActiveMutations = 0;
  let completedMutations = 0;

  await Promise.all(
    Array.from({ length: 48 }, async (_, index) =>
      mutate({
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

  expect({ completedMutations, maximumActiveMutations, activeMutations }).toEqual({
    completedMutations: 48,
    maximumActiveMutations: 1,
    activeMutations: 0,
  });
  expect(getSessionMutationCount()).toBe(0);
});

it("interrupts admitted work in both stores before a cross-store mutation", async () => {
  const main = target("store-cross-interrupt-a", "agent:main:main", "session-cross-interrupt-a");
  const work = target("store-cross-interrupt-b", "agent:work:main", "session-cross-interrupt-b");
  const admitInterruptible = async (owner: Target) => {
    const onInterrupt = vi.fn(() => admission.release());
    const admission = await admit({ ...owner, onInterrupt });
    return { admission, onInterrupt };
  };
  const admissions = await Promise.all([admitInterruptible(main), admitInterruptible(work)]);

  try {
    await mutate({
      targets: [work, main],
      prepare: async () => {
        const interrupted = await Promise.all([
          interrupt({ ...main, timeoutMs: 1_000 }),
          interrupt({ ...work, timeoutMs: 1_000 }),
        ]);
        expect(interrupted).toEqual([true, true]);
      },
      run: async () => {
        for (const { onInterrupt } of admissions) {
          expect(onInterrupt).toHaveBeenCalledOnce();
        }
        for (const { scope, identities } of [main, work]) {
          expect(workActive(scope, identities)).toBe(false);
        }
      },
    });
  } finally {
    for (const { admission } of admissions) {
      admission.release();
    }
  }
});

it("cancels an opposite-direction cross-store mutation before activation", async () => {
  const main = target("store-cross-cancel-a", "agent:main:main", "session-cross-cancel-a");
  const work = target("store-cross-cancel-b", "agent:work:main", "session-cross-cancel-b");
  const held = holdMutation({ targets: [main, work] });
  const first = held.mutation;
  await held.started;

  const controller = new AbortController();
  const abortError = new Error("cancel queued cross-store lifecycle mutation");
  const run = vi.fn(async () => {});
  const cancelled = mutate({ targets: [work, main], signal: controller.signal, run });
  controller.abort(abortError);

  try {
    await expect(cancelled).rejects.toBe(abortError);
  } finally {
    held.release();
    await first;
  }

  expect(run).not.toHaveBeenCalled();
  expect(getSessionMutationCount()).toBe(0);
});

it("rejects an admission that resumes after suspension closes the async gap", async () => {
  resetGatewayWorkAdmission();
  const owner = target("store-suspend-race", "session-suspend-race", "backing-suspend-race");
  const held = holdMutation(owner);
  await held.started;
  expect(getSessionMutationCount()).toBeGreaterThan(0);

  const admission = admit(owner);
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  held.release();
  await held.mutation;
  expect(getSessionMutationCount()).toBe(0);

  await expect(admission).rejects.toMatchObject({ name: "GatewayDrainingError" });
  expect(getSessionControllerWorkCount()).toBe(0);
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
    (await admit(target("store-admitted-root", "session-admitted-root"))).release();
  });
  const suspension = tryBeginGatewaySuspendAdmission(() => {});

  try {
    continueRoot.resolve();
    await expect(active).resolves.toBeUndefined();
    await expect(admit(target("store-new-root", "session-new-root"))).rejects.toMatchObject({
      name: "GatewayDrainingError",
    });
  } finally {
    suspension?.rollback();
    root?.release();
    resetGatewayWorkAdmission();
  }
});

it.each([false, true])(
  "excludes its own lease during revalidation while retaining competing work (%s)",
  async (hasCompetingWork) => {
    const owner = target("store-revalidation", "agent:main:main", "session-revalidation");
    const competing = hasCompetingWork ? await admit(owner) : undefined;
    try {
      const admission = await admit({
        ...owner,
        revalidateAllowed: async () => {
          await Promise.resolve();
          expect(workActive(owner.scope, owner.identities)).toBe(true);
          expect(competingActive(owner.scope, owner.identities)).toBe(hasCompetingWork);
        },
      });
      try {
        expect(competingActive(owner.scope, owner.identities)).toBe(true);
      } finally {
        admission.release();
      }
      expect(workActive(owner.scope, owner.identities)).toBe(hasCompetingWork);
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
  const blocked = admit({
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
  const independent = admit({
    scope,
    identities: [independentKey, "independent-id"],
    storeWriterIdentities: [independentKey],
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
    expect(workActive(scope, [blockedKey])).toBe(false);
    expect(workActive(scope, [independentKey])).toBe(true);
    releaseIndependent.resolve();
    (await independent).release();
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
  const held = holdMutation(childTarget);
  const assertAllowed = vi.fn();
  const admission = admit({ ...target("store-a", "session-1"), assertAllowed });
  try {
    await held.started;
    expect(assertAllowed).not.toHaveBeenCalled();

    held.release();
    await held.mutation;
    await admission;
    expect(assertAllowed).toHaveBeenCalledOnce();
    expect(workActive("store-a", ["agent:main:child", "session-1"])).toBe(true);
  } finally {
    held.release();
    await held.mutation;
    (await admission).release();
  }
  expect(workActive("store-a", ["session-1"])).toBe(false);
});

it("tracks the active lifecycle mutation kind across identity aliases", async () => {
  const held = holdMutation(target("store-kind", "agent:main:child", "session-kind"), {
    kind: "compaction",
  });
  await held.started;

  expect(onlyKindActive("store-kind", ["session-kind"], "compaction")).toBe(true);
  expect(onlyKindActive("store-other", ["session-kind"], "compaction")).toBe(false);

  held.release();
  await held.mutation;
  expect(onlyKindActive("store-kind", ["session-kind"], "compaction")).toBe(false);
});

it("keeps identical session keys isolated by store", async () => {
  const admissionLease = await admit(target("store-a", "global", "session-a"));

  try {
    expect(workActive("store-a", ["global"])).toBe(true);
    expect(workActive("store-b", ["global"])).toBe(false);
    const run = vi.fn(async () => {});
    await mutate({ ...target("store-b", "global"), run });
    expect(run).toHaveBeenCalledOnce();
  } finally {
    admissionLease.release();
  }
});

it("cancels work admission waiting behind a lifecycle mutation", async () => {
  const held = holdMutation(childTarget, { prepare: true });
  await held.started;

  const controller = new AbortController();
  const abortError = new Error("reset interrupted admission");
  const admission = admit({ ...target("store-a", "session-1"), signal: controller.signal });
  controller.abort(abortError);

  await expect(admission).rejects.toBe(abortError);
  held.release();
  await held.mutation;
});

it("preserves the initiating admission across a queued lifecycle mutation", async () => {
  const onInterrupt = vi.fn();
  const admission = await admit({ ...childTarget, onInterrupt });
  const held = holdMutation(childTarget);
  const first = held.mutation;
  await held.started;

  let initiatingAdmissionExcluded = false;
  const queued = admission.run(
    async () =>
      await mutate({
        ...childTarget,
        prepare: async () => {
          initiatingAdmissionExcluded = await interrupt({ ...childTarget, timeoutMs: 1 });
        },
        run: async () => {},
      }),
  );

  try {
    held.release();
    await first;
    await queued;
    expect(initiatingAdmissionExcluded).toBe(true);
    expect(onInterrupt).not.toHaveBeenCalled();
  } finally {
    held.release();
    admission.release();
    await Promise.allSettled([first, queued]);
  }
});

it("bounds interruption waits for non-cooperative work", async () => {
  const admissionLease = await admit({ ...childTarget, onInterrupt: () => {} });

  try {
    await expect(interrupt({ ...target("store-a", "session-1"), timeoutMs: 1 })).resolves.toBe(
      false,
    );
  } finally {
    admissionLease.release();
  }
});

it("shares lifecycle coordination across duplicate module instances", async () => {
  const first = await importFreshModule<typeof import("./session-controller.lifecycle.js")>(
    import.meta.url,
    "./session-controller.lifecycle.js?scope=session-lifecycle-a",
  );
  const second = await importFreshModule<typeof import("./session-controller.lifecycle.js")>(
    import.meta.url,
    "./session-controller.lifecycle.js?scope=session-lifecycle-b",
  );
  let releaseLease = () => {};
  const onInterrupt = vi.fn(() => releaseLease());
  const lease = await first.beginSessionEffect({
    scope: "store-duplicate",
    identities: ["agent:main:child", "session-duplicate"],
    assertAllowed: () => {},
    onInterrupt,
  });
  releaseLease = lease.release;

  try {
    expect(second.isSessionControllerWorkActive("store-duplicate", ["session-duplicate"])).toBe(
      true,
    );
    await expect(
      second.interruptSessionControllerEffects({
        scope: "store-duplicate",
        identities: ["agent:main:child"],
        timeoutMs: 50,
      }),
    ).resolves.toBe(true);
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(first.isSessionControllerWorkActive("store-duplicate", ["session-duplicate"])).toBe(
      false,
    );
  } finally {
    lease.release();
  }
});

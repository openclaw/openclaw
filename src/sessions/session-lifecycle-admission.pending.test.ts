import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import {
  beginSessionWorkAdmission,
  captureSessionWorkRunInterruptions,
  collectActiveSessionWorkAdmissions,
  getActiveSessionWorkAdmissionCount,
  getCompetingSessionWorkAdmissionRelease,
  getSessionWorkAdmissionRelease,
  interruptSessionWorkAdmissions,
  isCompetingSessionWorkAdmissionActive,
  isSessionWorkAdmissionActive,
  captureGatewaySessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  startSessionWorkAdmissionInterruption,
} from "./session-lifecycle-admission.js";

it.each(["released", "interrupted", "undeclared", "caller", "wrong receipt"] as const)(
  "targeted run interruption rejects a %s admission",
  async (state) => {
    const target = { scope: "capture-current.sqlite", identities: ["capture-current-session"] };
    const run = { runId: "captured-run" };
    const onInterrupt = vi.fn(() => ({
      runId: state === "wrong receipt" ? "different-run" : run.runId,
    }));
    const admission = await beginSessionWorkAdmission({
      ...target,
      ...(state === "undeclared" ? {} : { run }),
      assertAllowed: () => {},
      onInterrupt,
    });
    const capture = () => captureSessionWorkRunInterruptions({ ...target, accept: () => true });
    try {
      const captured = state === "caller" ? await admission.run(async () => capture()) : capture();
      if (state === "undeclared" || state === "caller") {
        expect(captured).toEqual([]);
        expect(onInterrupt).not.toHaveBeenCalled();
        return;
      }
      expect(captured).toHaveLength(1);
      if (state === "released") {
        admission.release();
      } else if (state === "interrupted") {
        startSessionWorkAdmissionInterruption(target);
        onInterrupt.mockClear();
      }
      expect(captured[0]!.interrupt(createAgentRunDirectAbortError())).toBe(false);
      expect(onInterrupt).toHaveBeenCalledTimes(state === "wrong receipt" ? 1 : 0);
      expect(capture()).toEqual([]);
    } finally {
      admission.release();
    }
  },
);

it("targeted Stop cancels a declared queued run without interrupting its predecessor", async () => {
  const target = {
    scope: "capture-pending.sqlite",
    identities: ["capture-pending-session"],
    owner: Symbol("queued-run"),
    serializeOwner: true,
  };
  const predecessorInterrupt = vi.fn();
  const predecessor = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
    onInterrupt: predecessorInterrupt,
  });
  const run = { runId: "queued-run" };
  const validate = vi.fn();
  const onInterrupt = vi.fn(() => ({ runId: run.runId }));
  const pending = beginSessionWorkAdmission({
    ...target,
    run,
    assertAllowed: validate,
    onInterrupt,
  });
  const reason = createAgentRunDirectAbortError();
  const rejected = expect(pending).rejects.toBe(reason);
  try {
    const captured = captureSessionWorkRunInterruptions({ ...target, accept: () => true });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.interrupt(reason)).toBe(true);
    expect(captured[0]!.interrupt(reason)).toBe(false);
    await rejected;
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(predecessorInterrupt).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(predecessor.isActive()).toBe(true);
  } finally {
    predecessor.release();
    await pending.catch(() => {});
  }
});

it("serializes pending owners in FIFO order without blocking other owners", async ({ signal }) => {
  const scope = "serialized-owners.sqlite";
  const identities = ["agent:main:serialized", "serialized-session"];
  const owner = Symbol("serialized-command");
  const entered = createDeferred();
  const allowed = createDeferred();
  const order: string[] = [];
  const first = beginSessionWorkAdmission({
    scope,
    identities,
    owner,
    serializeOwner: true,
    signal,
    assertAllowed: async () => {
      entered.resolve();
      await allowed.promise;
      order.push("first");
    },
    revalidateAllowed: () => {},
  });
  await withinTest(entered.promise, signal);
  const follow = (name: string) =>
    beginSessionWorkAdmission({
      scope,
      identities: [identities[1]],
      owner,
      serializeOwner: true,
      signal,
      assertAllowed: () => {
        order.push(name);
      },
      revalidateAllowed: () => {},
    });
  const followers = [follow("second"), follow("third")] as const;
  const passOtherOwner = async () => {
    const lease = await beginSessionWorkAdmission({
      scope,
      identities,
      owner: Symbol("independent-owner"),
      serializeOwner: true,
      signal,
      assertAllowed: () => {},
    });
    lease.release();
  };
  try {
    allowed.resolve();
    const firstLease = await withinTest(first, signal);
    await withinTest(passOtherOwner(), signal);
    expect(order).toEqual(["first"]);
    firstLease.release();

    const secondLease = await withinTest(followers[0], signal);
    await withinTest(passOtherOwner(), signal);
    expect(order).toEqual(["first", "second"]);
    secondLease.release();

    (await withinTest(followers[1], signal)).release();
    expect(order).toEqual(["first", "second", "third"]);
  } finally {
    allowed.resolve();
    for (const attempt of [first, ...followers]) {
      await attempt.then(
        (lease) => lease.release(),
        () => {},
      );
    }
  }
});

it("lets an inherited owner finish ahead of its queued successor", async ({ signal }) => {
  const target = {
    scope: "nested-owner.sqlite",
    identities: ["nested-owner-session"],
    owner: Symbol("nested-command"),
    serializeOwner: true as const,
    signal,
    assertAllowed: () => {},
  };
  const outer = await beginSessionWorkAdmission(target);
  const validateFollower = vi.fn();
  const follower = beginSessionWorkAdmission({ ...target, assertAllowed: validateFollower });
  try {
    await withinTest(
      outer.run(async () => {
        const inner = await beginSessionWorkAdmission(target);
        inner.release();
      }),
      signal,
    );
    expect(outer.isActive()).toBe(true);
    expect(validateFollower).not.toHaveBeenCalled();
  } finally {
    outer.release();
    await follower.then(
      (lease) => lease.release(),
      () => {},
    );
  }
  expect(validateFollower).toHaveBeenCalled();
});

it.for(["caller abort", "Stop"])(
  "cancels a pending owner wait on %s before its predecessor releases",
  async (cancellation, { signal }) => {
    const scope = `cancel-owner-${cancellation}.sqlite`;
    const identities = ["cancel-owner-session"];
    const owner = Symbol("cancel-command");
    const controller = new AbortController();
    const reason = createAgentRunDirectAbortError();
    const predecessor = await beginSessionWorkAdmission({
      scope,
      identities,
      owner,
      serializeOwner: true,
      assertAllowed: () => {},
    });
    const validate = vi.fn();
    const pending = beginSessionWorkAdmission({
      scope,
      identities,
      owner,
      serializeOwner: true,
      signal: AbortSignal.any([controller.signal, signal]),
      assertAllowed: validate,
    }).then(
      (lease) => {
        lease.release();
        return "incorrectly admitted";
      },
      (error: unknown) => error,
    );
    try {
      const independent = await beginSessionWorkAdmission({
        scope,
        identities,
        signal,
        assertAllowed: () => {},
      });
      independent.release();
      if (cancellation === "caller abort") {
        controller.abort(reason);
      } else {
        await predecessor.run(async () => {
          const interrupted = startSessionWorkAdmissionInterruption({ scope, identities, reason });
          await withinTest(interrupted.released, signal);
        });
      }
      expect(await withinTest(pending, signal)).toBe(reason);
      expect(validate).not.toHaveBeenCalled();
      expect(predecessor.isActive()).toBe(true);
    } finally {
      controller.abort(reason);
      predecessor.release();
      await pending;
    }
  },
);

it("rejects arrivals during awaited cleanup and its final microtask, then reopens only after release", async () => {
  const scope = "hostile-await.sqlite";
  const identities = ["agent:main:fence", "fence-session"];
  const entered = createDeferred();
  const release = createDeferred();
  const reason = createAgentRunDirectAbortError();
  let lateResult: unknown;
  const late = () =>
    beginSessionWorkAdmission({ scope, identities, assertAllowed: () => {} }).then(
      (lease) => {
        lease.release();
        return "incorrectly admitted";
      },
      (error: unknown) => error,
    );
  const stop = runExclusiveSessionLifecycleMutation("drain", {
    scope,
    identities,
    prepare: async (owner) => {
      owner.closeWorkAdmissions(reason);
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
    finalize: async () => {
      await Promise.resolve();
      lateResult = await late();
    },
  });
  await entered.promise;
  try {
    const whileAwaiting = await late();
    expect(whileAwaiting).toBe(reason);
    const other = await beginSessionWorkAdmission({
      scope,
      identities: ["other-session"],
      assertAllowed: () => {},
    });
    other.release();
    release.resolve();
    await stop;
    expect(lateResult).toBe(reason);
    const fresh = await beginSessionWorkAdmission({ scope, identities, assertAllowed: () => {} });
    fresh.release();
  } finally {
    release.resolve();
    await stop;
  }
});

it("interrupts a preexisting non-chat pending attempt without classifying it as active work", async () => {
  const scope = "non-chat-pending.sqlite";
  const resolveGatewayContext = () => undefined;
  const identities = ["agent:main:pending", "pending-session"] as const;
  const entered = createDeferred();
  const release = createDeferred();
  const interrupted = vi.fn();
  let validated = false;
  const blocker = runExclusiveSessionLifecycleMutation("patch", {
    scope,
    identities,
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
  });
  await entered.promise;
  const pending = beginSessionWorkAdmission({
    scope,
    identities,
    onInterrupt: interrupted,
    resolveGatewayContext,
    assertAllowed: () => {
      validated = true;
    },
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly admitted";
    },
    (error: unknown) => error,
  );
  try {
    expect(isSessionWorkAdmissionActive(scope, identities)).toBe(false);
    expect(
      captureGatewaySessionWorkAdmissions(resolveGatewayContext).isActive({
        scope,
        sessionKey: identities[0],
        sessionId: identities[1],
      }),
    ).toBe(false);
    expect(isCompetingSessionWorkAdmissionActive(scope, identities)).toBe(false);
    expect(getSessionWorkAdmissionRelease({ scope, identities })).toBeUndefined();
    const competingRelease = getCompetingSessionWorkAdmissionRelease({ scope, identities });
    expect(competingRelease).toBeDefined();
    expect(collectActiveSessionWorkAdmissions().get(scope)).toBeUndefined();
    expect(getActiveSessionWorkAdmissionCount()).toBe(0);
    const reason = createAgentRunDirectAbortError();
    expect(
      await interruptSessionWorkAdmissions({ scope, identities, reason, timeoutMs: 1000 }),
    ).toBe(true);
    expect(await pending).toBe(reason);
    await expect(competingRelease).resolves.toBeUndefined();
    expect(interrupted).toHaveBeenCalledOnce();
    expect(interrupted).toHaveBeenCalledWith(reason);
    expect(validated).toBe(false);
  } finally {
    release.resolve();
    await blocker;
    await pending;
  }
});

it("ordinary compaction still queues work and acquired-release queries do not deadlock it", async () => {
  const scope = "compaction.sqlite";
  const identities = ["compaction-session"];
  const entered = createDeferred();
  const release = createDeferred();
  let validated = false;
  const compaction = runExclusiveSessionLifecycleMutation("compact", {
    scope,
    identities,
    kind: "compaction",
    prepare: async () => {
      entered.resolve();
      await release.promise;
      await getSessionWorkAdmissionRelease({ scope, identities });
    },
    run: async () => {},
  });
  await entered.promise;
  const pending = beginSessionWorkAdmission({
    scope,
    identities,
    assertAllowed: () => {
      validated = true;
    },
  });
  try {
    expect(validated).toBe(false);
    release.resolve();
    await compaction;
    const lease = await pending;
    expect(validated).toBe(true);
    lease.release();
  } finally {
    release.resolve();
    await compaction;
    (await pending).release();
  }
});

it("single-use identity iterators still wait for the exact lifecycle fence", async () => {
  const scope = "generator.sqlite";
  const identities = ["generator-session"];
  const entered = createDeferred();
  const release = createDeferred();
  let validated = false;
  const mutation = runExclusiveSessionLifecycleMutation("patch", {
    scope,
    identities,
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
  });
  await entered.promise;
  const admission = beginSessionWorkAdmission({
    scope,
    identities: (function* () {
      yield identities[0];
    })(),
    assertAllowed: () => {
      validated = true;
    },
  });
  try {
    const unrelated = await beginSessionWorkAdmission({
      scope,
      identities: ["unrelated-generator"],
      assertAllowed: () => {},
    });
    unrelated.release();
    expect(validated).toBe(false);
    release.resolve();
    await mutation;
    const lease = await admission;
    expect(validated).toBe(true);
    lease.release();
  } finally {
    release.resolve();
    await mutation;
    (await admission).release();
  }
});

it("an initial validator finishing after pending cancellation cannot enter the writer", async () => {
  const scope = "initial-validator.sqlite";
  const identities = ["initial-validator-session"];
  const entered = createDeferred();
  const release = createDeferred();
  const writer = vi.fn();
  const reason = createAgentRunDirectAbortError();
  const pending = beginSessionWorkAdmission({
    scope,
    identities,
    assertAllowed: async () => {
      entered.resolve();
      await release.promise;
    },
    revalidateAllowed: writer,
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly admitted";
    },
    (error: unknown) => error,
  );
  await entered.promise;
  try {
    expect(
      await interruptSessionWorkAdmissions({ scope, identities, reason, timeoutMs: 1000 }),
    ).toBe(true);
    expect(await pending).toBe(reason);
    release.resolve();
    // A later mutation must wait for the validator's existing identity lock to finish.
    await runExclusiveSessionLifecycleMutation("patch", { scope, identities, run: async () => {} });
    expect(writer).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await pending;
  }
});

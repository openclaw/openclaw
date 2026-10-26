import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "./agent-events.js";
import {
  captureAgentRunDelegatedSourceAssertion,
  claimAgentRunApprovalAuthority,
  claimAgentRunContext,
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunDelegatedAuthorityClosedHandler,
  releaseAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  sweepStaleRunContexts,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";

beforeEach(() => resetAgentEventsForTest());

function claimAuthority(instanceId: string, runId = "run", source?: () => void) {
  return claimAgentRunDelegatedAuthority({ instanceId, runId }, source);
}

function observeClosure(
  handler: Parameters<typeof registerAgentRunDelegatedAuthorityClosedHandler>[0],
) {
  const stop = registerAgentRunDelegatedAuthorityClosedHandler(handler);
  onTestFinished(stop);
  return stop;
}

const refuseChild = () => {
  throw new Error("child authority closed");
};

test.each([undefined, "current"])(
  "closes exact authorities despite %s-generation terminal clear",
  (generation) => {
    const closed: string[] = [];
    observeClosure(({ operationalRunInstance }) => closed.push(operationalRunInstance.instanceId));
    claimAuthority("instance-1", "shared-run");
    const second = claimAuthority("instance-2", "shared-run");
    expect(closed).toEqual(["instance-1"]);

    clearAgentRunContext("shared-run", generation ? getAgentEventLifecycleGeneration() : undefined);
    expect(closed).toEqual(["instance-1"]);
    expect(validateAgentRunDelegatedAuthority(second)).toBe(true);
    expect(releaseAgentRunDelegatedAuthority(second)).toBe(true);
    expect(closed).toEqual(["instance-1", "instance-2"]);

    claimAuthority("instance-3", "shared-run");
    rotateAgentEventLifecycleGeneration();
    expect(closed).toEqual(["instance-1", "instance-2", "instance-3"]);
  },
);

test("authority closure reaches concurrent observers despite errors and independent unsubscribe", () => {
  const closed: string[] = [];
  observeClosure(({ operationalRunInstance }) =>
    closed.push(`approval:${operationalRunInstance.instanceId}`),
  );
  observeClosure(() => {
    throw new Error("observer failed");
  });
  const stopTransferObserver = observeClosure(({ operationalRunInstance }) =>
    closed.push(`transfer:${operationalRunInstance.instanceId}`),
  );
  const first = claimAuthority("first");
  releaseAgentRunDelegatedAuthority(first);
  expect(closed).toEqual(["approval:first", "transfer:first"]);
  stopTransferObserver();
  const second = claimAuthority("second");
  releaseAgentRunDelegatedAuthority(second);
  expect(closed).toEqual(["approval:first", "transfer:first", "approval:second"]);
});

test.each(["close", "replacement", "restart"])(
  "approval generations retain all signal fences and close with parent %s",
  (reason) => {
    const instance = { instanceId: "instance-scopes", runId: "run-scopes" };
    const parent = claimAgentRunDelegatedAuthority(instance);
    const [outer, inner] = [new AbortController(), new AbortController()] as const;
    const scope = claimAgentRunApprovalAuthority(parent, [outer.signal, inner.signal]);
    const copied = structuredClone(scope);
    expect(claimAgentRunApprovalAuthority(parent, [inner.signal, outer.signal])).toBe(scope);
    expect(validateAgentRunDelegatedAuthority(copied)).toBe(true);
    inner.abort();
    expect(validateAgentRunDelegatedAuthority(copied)).toBe(false);
    expect(validateAgentRunDelegatedAuthority(parent)).toBe(true);

    const next = claimAgentRunApprovalAuthority(parent, [outer.signal]);
    if (reason === "close") {
      releaseAgentRunDelegatedAuthority(parent);
    } else if (reason === "replacement") {
      claimAgentRunDelegatedAuthority({ ...instance, instanceId: "replacement" });
    } else {
      rotateAgentEventLifecycleGeneration();
    }
    expect(validateAgentRunDelegatedAuthority(next)).toBe(false);
    outer.abort();
  },
);

test.each(["release", "abort"])(
  "nested approval scopes retain their original worker through %s and reentrant cleanup",
  (closure) => {
    const root = claimAuthority("nested-instance", "nested-run");
    onTestFinished(() => {
      releaseAgentRunDelegatedAuthority(root);
    });
    const workerLifetime = new AbortController();
    const worker = claimAgentRunApprovalAuthority(root, [workerLifetime.signal]);
    const request = claimAgentRunApprovalAuthority({ ...worker }, [new AbortController().signal]);
    const child = claimAgentRunApprovalAuthority(request, [new AbortController().signal]);
    const sibling = claimAgentRunApprovalAuthority(root, [new AbortController().signal]);
    const copiedChild = structuredClone(child);
    const source = captureAgentRunDelegatedSourceAssertion(copiedChild, refuseChild);
    expect(source).toBeDefined();
    expect(() => source?.assertCurrent()).not.toThrow();
    expect(validateAgentRunDelegatedAuthority(copiedChild, worker)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(worker, request)).toBe(false);
    expect(validateAgentRunDelegatedAuthority(sibling, worker)).toBe(false);
    // Claim, reason, child/root/sibling liveness, and repeated-release result at notification time.
    const closed: Array<[string, string | undefined, boolean, boolean, boolean, boolean]> = [];
    observeClosure((authority, reason) => {
      closed.push([
        authority.claimId,
        reason,
        validateAgentRunDelegatedAuthority(copiedChild),
        validateAgentRunDelegatedAuthority(root),
        validateAgentRunDelegatedAuthority(sibling),
        releaseAgentRunDelegatedAuthority(child),
      ]);
    });
    if (closure === "release") {
      releaseAgentRunDelegatedAuthority(worker);
    } else {
      workerLifetime.abort();
    }
    const closedState = ["approval-scope-closed", false, true, true, false];
    expect(closed).toEqual(
      [child, request, worker].map(({ claimId }) => closedState.toSpliced(0, 0, claimId)),
    );
    expect(validateAgentRunDelegatedAuthority(copiedChild)).toBe(false);
    expect(() => source?.assertCurrent()).toThrow("child authority closed");
    expect(captureAgentRunDelegatedSourceAssertion(copiedChild, refuseChild)).toBeUndefined();
    expect(() => claimAgentRunApprovalAuthority(worker, [])).toThrow("no longer active");
  },
);

test("stale projection sweeping cannot retire a live delegated authority claim", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const authority = claimAgentRunDelegatedAuthority({
    instanceId: "instance-live",
    runId: "live-run",
  });
  clock.mockReturnValue(10_000);

  expect(sweepStaleRunContexts(500)).toBe(0);
  expect(getAgentRunContext(authority.operationalRunInstance.runId)).toBeDefined();
  clock.mockRestore();
});

test("terminal clear preserves exact authority until its outer owner closes", () => {
  using clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const delayedOwner = claimAgentRunContext(
    "delayed-terminal-run",
    { lifecycleGeneration, sessionKey: "agent:main:delayed" },
    { trackOwner: true },
  );
  const closed: string[] = [];
  observeClosure((authority) => closed.push(authority.claimId));
  const authority = claimAuthority("instance-delayed", "delayed-terminal-run");
  const copiedAuthority = structuredClone(authority);
  expect(validateAgentRunDelegatedAuthority(copiedAuthority)).toBe(true);
  clearAgentRunContext("delayed-terminal-run", lifecycleGeneration);

  expect(closed).toEqual([]);
  expect(getAgentRunContext("delayed-terminal-run")).toBeDefined();
  clock.mockReturnValue(10_000);
  expect(sweepStaleRunContexts(500)).toBe(0);
  expect(validateAgentRunDelegatedAuthority(copiedAuthority)).toBe(true);
  expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
  expect(closed).toEqual([authority.claimId]);
  expect(validateAgentRunDelegatedAuthority(copiedAuthority)).toBe(false);
  expect(getAgentRunContext("delayed-terminal-run")).toBeDefined();
  releaseAgentRunContext("delayed-terminal-run", delayedOwner);
  expect(getAgentRunContext("delayed-terminal-run")).toBeUndefined();
});

test.each(["parent cleanup", "approval cleanup", "omitted rebind", "replaced rebind"] as const)(
  "preserves source binding through %s after revocation",
  (kind) => {
    const assertSourceCurrent = vi.fn();
    const instance = { instanceId: "bound-instance", runId: "bound-run" };
    const parent = claimAgentRunDelegatedAuthority(instance, assertSourceCurrent);
    onTestFinished(() => {
      releaseAgentRunDelegatedAuthority(parent);
    });
    const rebind = kind === "omitted rebind" || kind === "replaced rebind";
    if (rebind) {
      expect(claimAgentRunDelegatedAuthority(instance, assertSourceCurrent)).toBe(parent);
    }
    const authority =
      kind === "approval cleanup"
        ? claimAgentRunApprovalAuthority(parent, [new AbortController().signal])
        : parent;
    assertSourceCurrent.mockClear().mockImplementation(() => {
      throw new Error("source retired");
    });
    if (rebind) {
      const replacement = vi.fn();
      expect(() =>
        claimAgentRunDelegatedAuthority(
          instance,
          kind === "replaced rebind" ? replacement : undefined,
        ),
      ).toThrow("already bound");
      expect(replacement).not.toHaveBeenCalled();
    }
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    if (!rebind) {
      expect(assertSourceCurrent).not.toHaveBeenCalled();
    }
    if (kind === "approval cleanup") {
      expect(releaseAgentRunDelegatedAuthority(parent)).toBe(true);
    }
    if (!rebind) {
      expect(getAgentRunContext(instance.runId)).toBeUndefined();
    }
  },
);

test.each(["replacement", "restart"])(
  "rechecks the exact owner after a source callback causes %s",
  (outcome) => {
    let duringCheck: (() => void) | undefined;
    const sourceAssertion = () => {
      const run = duringCheck;
      duringCheck = undefined;
      run?.();
    };
    const first = claimAuthority("source-first", "source-run", sourceAssertion);
    let successor: typeof first | undefined;
    duringCheck = () => {
      if (outcome === "restart") {
        rotateAgentEventLifecycleGeneration();
      }
      successor = claimAuthority("source-next", "source-run");
    };
    expect(validateAgentRunDelegatedAuthority(first)).toBe(false);
    expect(validateAgentRunDelegatedAuthority(successor!)).toBe(true);
    expect(releaseAgentRunDelegatedAuthority(first)).toBe(false);
    expect(releaseAgentRunDelegatedAuthority(successor!)).toBe(true);
  },
);

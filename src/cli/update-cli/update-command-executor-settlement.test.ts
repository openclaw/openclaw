import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import type { ManagedHandoffLease } from "../../infra/update-managed-service-handoff-lease.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import {
  captureUpdateCommandExecutorAuthority,
  releaseUpdateCommandPreflightForHandoff,
  withDelegatedUpdateCommandExecutor,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
  type UpdateCommandExecutor,
} from "./update-command-executor.js";
import { resolvePackageRuntimePreflight } from "./update-command-service-plan.js";
import { createUpdateOperationDeadline } from "./update-operation-deadline.js";

const boundaries = vi.hoisted(() => ({ store: vi.fn(), runtime: vi.fn() }));
vi.mock("../../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-paths.js")>()),
  resolveNodeRuntimeInfo: boundaries.runtime,
}));
vi.mock("../../infra/update-managed-service-handoff-lease.js", () => ({
  createManagedHandoffLeaseStore: boundaries.store,
  resolveManagedUpdateLeaseDatabasePath: () => "/synthetic/leases.sqlite",
}));
vi.mock("../../infra/update-managed-service-handoff-database.js", () => ({
  captureManagedUpdateLeaseDatabaseIdentity: () => ({
    databasePath: "/synthetic/leases.sqlite",
    databaseIdentity: "database",
    parentIdentity: "directory",
  }),
}));
vi.mock("../../infra/update-install-root.js", () => ({
  resolveUpdateInstallRoot: (root: string) => root,
}));
vi.mock("./update-command-identity-warning.js", () => ({
  createUpdateIdentityWarningReporter: () => ({ warn: vi.fn(), flush: vi.fn() }),
}));

const root = "/synthetic/install";
const rows = new Map<string, ManagedHandoffLease>();
const readers = new Set<Disposable>();
function lease(key: string, owner: string, pid = process.pid): ManagedHandoffLease {
  return {
    key,
    owner,
    version: 2,
    action: { kind: "update" },
    helper: { pid, startIdentity: "synthetic" },
    executor: { pid, startIdentity: "synthetic" },
    payload: key,
    updatedAt: 1,
  };
}

beforeEach(() => {
  rows.clear();
  boundaries.runtime.mockReset();
  const current = (candidate: ManagedHandoffLease) => rows.get(candidate.key) === candidate;
  boundaries.store.mockReturnValue({
    retainReadConnection: () => {
      const reader = {
        [Symbol.dispose]() {
          readers.delete(reader);
        },
      };
      readers.add(reader);
      return reader;
    },
    read: (key: string) => {
      const found = rows.get(key);
      return found ? { kind: "current", lease: found } : { kind: "absent" };
    },
    acquire: (key: string, owner: string) => {
      if (rows.has(key)) {
        return { kind: "busy" };
      }
      const acquired = lease(key, owner);
      rows.set(key, acquired);
      return { kind: "acquired", lease: acquired };
    },
    release: (candidate: ManagedHandoffLease) => current(candidate) && rows.delete(candidate.key),
    bind: (candidate: ManagedHandoffLease) => (current(candidate) ? candidate : undefined),
    current,
    owns: current,
    isProcessIdentityCurrent: () => true,
    acceptParentBoundExecutor: current,
  });
});

function runWithExecutorFence<T>(
  kind: "direct" | "delegated",
  operation: (fence: UpdateRecoveryFence) => Promise<T>,
  activationTimeoutMs?: number,
): Promise<T> {
  if (kind === "direct") {
    return withUpdateCommandExecutor("run", async (executor) =>
      operation(await executor.enter(root, { activationTimeoutMs })),
    );
  }
  const parent = lease(root, "parent", process.ppid);
  const childKey = `${root}/.openclaw-update-child-00000000-0000-0000-0000-000000000000`;
  rows.set(root, parent);
  rows.set(childKey, { ...lease(childKey, "run"), helper: parent.executor });
  return withDelegatedUpdateCommandExecutor(
    { runId: "run", root, databasePath: "/synthetic/leases.sqlite", parent, childKey },
    "run",
    root,
    operation,
    activationTimeoutMs === undefined ? undefined : { activationTimeoutMs },
  );
}

it.each([
  { kind: "direct", rejects: false },
  { kind: "direct", rejects: true },
  { kind: "delegated", rejects: false },
  { kind: "delegated", rejects: true },
] as const)(
  "lets the admitted $kind child finish before stopping its operation scope (rejects: $rejects)",
  async ({ kind, rejects }) => {
    const admitted = createDeferredCore();
    const finish = createDeferredCore();
    const original = new Error("operation failed after child admission");
    let signal: AbortSignal | undefined;
    let child: Promise<unknown> | undefined;
    let ended = false;
    const work = runWithExecutorFence(kind, async (fence) => {
      child = withUpdateCommandExecutorChild(fence, root, async (_grant, bind) => {
        bind(process.pid + 1);
        signal = resolveCommandProcessSignal();
        admitted.resolve();
        await finish.promise;
        signal!.throwIfAborted();
        return "child finished";
      });
      void child.catch(() => undefined);
      await admitted.promise;
      if (rejects) {
        throw original;
      }
      return "operation finished";
    })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        ended = true;
      });
    try {
      await admitted.promise;
      await setImmediate();
      expect(ended).toBe(false);
      expect(rows.has(root)).toBe(true);
      expect(signal?.aborted).toBe(false);
    } finally {
      finish.resolve();
      await Promise.allSettled([work, child]);
    }
    await expect(child).resolves.toBe("child finished");
    expect(await work).toEqual(rejects ? { error: original } : { value: "operation finished" });
    expect(rows.size).toBe(kind === "direct" ? 0 : 2);
  },
);

it.each([
  { kind: "direct", cleanupResult: "forced" },
  { kind: "direct", cleanupResult: "uncertain" },
  { kind: "delegated", cleanupResult: "forced" },
  { kind: "delegated", cleanupResult: "uncertain" },
] as const)(
  "cancels the admitted $kind child at its activation deadline and joins $cleanupResult cleanup",
  async ({ kind, cleanupResult }) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const admitted = createDeferredCore();
    const cancelled = createDeferredCore();
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    let signal: AbortSignal | undefined;
    let child: Promise<unknown> | undefined;
    let ended = false;
    const work = runWithExecutorFence(
      kind,
      async (fence) => {
        child = withUpdateCommandExecutorChild(fence, root, async (_grant, bind) => {
          bind(process.pid + 1);
          signal = resolveCommandProcessSignal();
          retainCommandProcessCleanup(cleanup.promise);
          signal!.addEventListener("abort", () => cancelled.resolve(), { once: true });
          admitted.resolve();
          await cancelled.promise;
          throw signal!.reason;
        });
        void child.catch(() => undefined);
        await admitted.promise;
        return "operation finished";
      },
      1000,
    )
      .catch((error: unknown) => error)
      .finally(() => {
        ended = true;
      });
    try {
      await admitted.promise;
      await setImmediate();
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await cancelled.promise;
      expect(signal?.reason).toBeInstanceOf(UpdateActivationTimeoutError);
      expect(ended).toBe(false);
      expect(rows.size).toBe(kind === "direct" ? 2 : 3);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ended).toBe(false);
      expect(rows.size).toBe(kind === "direct" ? 2 : 3);
    } finally {
      cleanup.resolve(cleanupResult);
      await Promise.allSettled([work, child]);
      await setImmediate();
    }
    const error = await work;
    const timeout = collectNestedErrorCandidates(error).find(
      (candidate) => candidate instanceof UpdateActivationTimeoutError,
    );
    expect(timeout).toBe(signal!.reason);
    expect(timeout).toMatchObject({ root, timeoutMs: 1000, reason: "update-activation-timeout" });
    expect(hasCommandProcessCleanupError(error)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "forced") {
      expect(error).toBe(signal!.reason);
    }
    expect(rows.size).toBe(
      cleanupResult === "uncertain" ? (kind === "direct" ? 2 : 3) : kind === "direct" ? 0 : 2,
    );
  },
);
afterEach(() => {
  try {
    expect(readers.size).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    readers.clear();
  }
});

it.each(["direct", "delegated"] as const)(
  "delivers a bounded %s timeout while its callback remains pending",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const admitted = createDeferredCore();
    const finish = createDeferredCore();
    let signal: AbortSignal | undefined;
    let ended = false;
    const work = runWithExecutorFence(
      kind,
      async () => {
        signal = resolveCommandProcessSignal();
        admitted.resolve();
        await finish.promise;
        signal!.throwIfAborted();
      },
      1000,
    )
      .catch((error: unknown) => error)
      .finally(() => {
        ended = true;
      });
    try {
      await admitted.promise;
      await vi.advanceTimersByTimeAsync(2000);
      expect(ended).toBe(true);
      expect(await work).toBe(signal!.reason);
      expect(await work).toBeInstanceOf(UpdateActivationTimeoutError);
      expect(rows.size).toBe(kind === "direct" ? 1 : 2);
    } finally {
      finish.resolve();
      await work;
      await setImmediate();
    }
    expect(rows.size).toBe(kind === "direct" ? 0 : 2);
  },
);

it.each(["forced", "uncertain"] as const)(
  "retains the direct lease until command cleanup reports %s",
  async (cleanupResult) => {
    const admitted = createDeferredCore();
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    const original = new Error("operation cancelled");
    let saved: UpdateCommandExecutor | undefined;
    let fence: UpdateRecoveryFence | undefined;
    const work = withUpdateCommandExecutor("run", async (executor) => {
      saved = executor;
      fence = await executor.enter(root);
      retainCommandProcessCleanup(cleanup.promise);
      admitted.resolve();
      throw original;
    }).catch((error: unknown) => error);
    try {
      await admitted.promise;
      await setImmediate();
      expect(rows.has(root)).toBe(true);
      expect(() => captureUpdateCommandExecutorAuthority(fence!)).not.toThrow();
    } finally {
      cleanup.resolve(cleanupResult);
      await work;
    }
    const error = await work;
    expect(hasCommandProcessCleanupError(error)).toBe(cleanupResult === "uncertain");
    expect(rows.has(root)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "forced") {
      expect(error).toBe(original);
    }
    expect(fence!.assertCurrent).toThrow("no longer current");
    await expect(saved!.enter(root)).rejects.toThrow("closed or busy");
  },
);

it.each(["forced", "uncertain"] as const)(
  "retains child lineage before startup binding until cleanup reports %s",
  async (cleanupResult) => {
    const admitted = createDeferredCore();
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    const original = new Error("startup cancelled");
    const candidateRoot = "/synthetic/candidate";
    let fence: UpdateRecoveryFence | undefined;
    let childWork: Promise<unknown> | undefined;
    const work = withUpdateCommandExecutor("run", async (executor) => {
      fence = await executor.enter(root);
      childWork = withUpdateCommandExecutorChild(fence, candidateRoot, async () => {
        retainCommandProcessCleanup(cleanup.promise);
        admitted.resolve();
        throw original;
      });
      await childWork;
    }).catch((error: unknown) => error);
    try {
      await admitted.promise;
      await setImmediate();
      expect(rows.size).toBe(4);
      expect(fence!.assertCurrent).toThrow("still running");
    } finally {
      cleanup.resolve(cleanupResult);
      await Promise.allSettled([work, childWork]);
    }
    const error = await work;
    expect(hasCommandProcessCleanupError(error)).toBe(cleanupResult === "uncertain");
    expect(rows.size).toBe(cleanupResult === "uncertain" ? 4 : 0);
    if (cleanupResult === "forced") {
      expect(error).toBe(original);
    }
    await expect(
      withUpdateCommandExecutorChild(fence!, candidateRoot, async () => {}),
    ).rejects.toThrow("live executor");
  },
);

it.each(["forced", "uncertain"] as const)(
  "keeps delegated authority through command cleanup reporting %s",
  async (cleanupResult) => {
    const parent = lease(root, "parent", process.ppid);
    const childKey = `${root}/.openclaw-update-child-00000000-0000-0000-0000-000000000000`;
    const child = { ...lease(childKey, "run"), helper: parent.executor };
    rows.set(root, parent);
    rows.set(childKey, child);
    const admitted = createDeferredCore();
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    let fence: UpdateRecoveryFence | undefined;
    const work = withDelegatedUpdateCommandExecutor(
      { runId: "run", root, databasePath: "/synthetic/leases.sqlite", parent, childKey },
      "run",
      root,
      async (current) => {
        fence = current;
        retainCommandProcessCleanup(cleanup.promise);
        admitted.resolve();
        return "complete";
      },
    ).catch((error: unknown) => error);
    try {
      await admitted.promise;
      await setImmediate();
      expect(() => captureUpdateCommandExecutorAuthority(fence!)).not.toThrow();
    } finally {
      cleanup.resolve(cleanupResult);
      await work;
    }
    const result = await work;
    expect(hasCommandProcessCleanupError(result)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "forced") {
      expect(result).toBe("complete");
    }
    expect(fence!.assertCurrent).toThrow("no longer has permission");
    expect(rows.size).toBe(2);
  },
);

it.each(["forced", "uncertain"] as const)(
  "settles a failed runtime probe before preflight handoff release (%s)",
  async (cleanupResult) => {
    const admitted = createDeferredCore();
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    let handedOff = false;
    boundaries.runtime
      .mockImplementationOnce(async () => {
        retainCommandProcessCleanup(cleanup.promise);
        admitted.resolve();
        return { status: "probe-failed", error: new Error("configured runtime probe timed out") };
      })
      .mockResolvedValueOnce({ status: "supported", version: "24.16.0" });
    const work = withUpdateCommandExecutor("run", async (executor) => {
      const fence = await executor.enter(root, { preflight: true });
      const runtime = await resolvePackageRuntimePreflight({
        root,
        target: { version: "2026.9.17", nodeEngine: ">=24.16.0" },
        alreadyCurrent: true,
        shouldRestart: true,
        service: {
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: true,
          serviceNodeRunner: "/synthetic/node",
          serviceUpdateVerdict: {
            kind: "owned",
            root,
            fingerprint: "definition",
            refreshDefinition: true,
          },
        },
      });
      expect(runtime.ok).toBe(true);
      releaseUpdateCommandPreflightForHandoff(fence);
      handedOff = true;
    }).catch((error: unknown) => error);
    try {
      await admitted.promise;
      await setImmediate();
      expect(handedOff).toBe(false);
      expect(rows.has(root)).toBe(true);
    } finally {
      cleanup.resolve(cleanupResult);
      await work;
    }
    expect(hasCommandProcessCleanupError(await work)).toBe(cleanupResult === "uncertain");
    expect(handedOff).toBe(cleanupResult === "forced");
    expect(rows.has(root)).toBe(cleanupResult === "uncertain");
  },
);

it.each([false, true])(
  "preserves activation timeout provenance without a cause cycle (uncertain: %s)",
  async (uncertain) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const deadline = createUpdateOperationDeadline();
    const admitted = createDeferredCore();
    const cancelled = createDeferredCore();
    const work = deadline
      .run(async () => {
        deadline.start(new UpdateActivationTimeoutError(root, 1000), 1000);
        admitted.resolve();
        await cancelled.promise;
        if (uncertain) {
          throw new CommandProcessCleanupError({ cause: deadline.signal.reason });
        }
        throw deadline.signal.reason;
      })
      .catch((error: unknown) => error);
    try {
      await admitted.promise;
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      cancelled.resolve();
      await work;
    }
    const result = await work;
    const timeout = collectNestedErrorCandidates(result).find(
      (error) => error instanceof UpdateActivationTimeoutError,
    );
    expect(timeout).toBe(deadline.signal.reason);
    expect(timeout).toMatchObject({ root, timeoutMs: 1000, reason: "update-activation-timeout" });
    if (!uncertain) {
      expect(result).toBe(deadline.signal.reason);
      return;
    }
    expect(result).not.toBe(deadline.signal.reason);
    expect(hasCommandProcessCleanupError(result)).toBe(true);
    expect(collectNestedErrorCandidates(result)).toEqual(
      expect.arrayContaining([deadline.signal.reason, expect.any(CommandProcessCleanupError)]),
    );
    const visit = (error: unknown, ancestors = new Set<unknown>()) => {
      if (!(error instanceof Error)) {
        return;
      }
      expect(ancestors.has(error)).toBe(false);
      const next = new Set([...ancestors, error]);
      visit(error.cause, next);
      if (error instanceof AggregateError) {
        for (const member of error.errors) {
          visit(member, next);
        }
      }
    };
    visit(result);
  },
);

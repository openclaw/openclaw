import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import type {
  createManagedHandoffLeaseStore,
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "../../infra/update-managed-service-handoff-lease.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import {
  CommandProcessCleanupError as CleanupError,
  hasCommandProcessCleanupError as hasCleanupError,
} from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import {
  captureUpdateCommandExecutorAuthority as captureAuthority,
  releaseUpdateCommandPreflightForHandoff as releasePreflight,
  withDelegatedUpdateCommandExecutor as withDelegatedExecutor,
  withUpdateCommandExecutor as withExecutor,
  withUpdateCommandExecutorChild as withChild,
  type UpdateCommandExecutor,
  registerUpdateCommandTerminalPreparation,
} from "./update-command-executor.js";
import { resolvePackageRuntimePreflight } from "./update-command-runtime-preflight.js";
import { createUpdateOperationDeadline } from "./update-operation-deadline.js";

const boundaries = vi.hoisted(() => ({ store: vi.fn(), runtime: vi.fn(), databasePath: "" }));
vi.mock("../../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-paths.js")>()),
  resolveNodeRuntimeInfo: boundaries.runtime,
}));
vi.mock("../../infra/update-managed-service-handoff-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-managed-service-handoff-lease.js")>()),
  prepareManagedHandoffLeaseStore: boundaries.store,
  resolveManagedUpdateLeaseDatabasePath: () => boundaries.databasePath,
}));
vi.mock("../../infra/update-managed-service-handoff-database.js", () => ({
  captureManagedUpdateLeaseDatabaseIdentity: () => ({
    databasePath: boundaries.databasePath,
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

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
type SettlementStore = Pick<
  ReturnType<typeof createManagedHandoffLeaseStore>,
  | "retainReadConnection"
  | "read"
  | "acquire"
  | "release"
  | "releaseAll"
  | "bindUpdateChildren"
  | "processIdentity"
  | "cancelUpdate"
  | "current"
  | "owns"
  | "isProcessIdentityCurrent"
  | "acceptParentBoundExecutor"
>;
const rows = new Map<string, ManagedHandoffLease>();
const readers = new Set<Disposable>();
const kinds = ["direct", "delegated"] as const;
const cleanupResults = ["forced", "uncertain"] as const;
const cleanupCases = kinds.flatMap((kind) =>
  cleanupResults.map((cleanupResult) => ({ kind, cleanupResult })),
);
const fakeTimers = () => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

function settlement(cleanupResult: "forced" | "uncertain" = "forced") {
  const admitted = createDeferredCore();
  const finish = createDeferredCore();
  const cleanup = createDeferredCore<"forced" | "uncertain">();
  let pending: Promise<unknown> | undefined;
  const track = <T>(work: Promise<T>) => {
    const tracked = work
      .catch((error: unknown) => {
        admitted.reject(error);
        return error;
      })
      .finally(() => {
        state.ended = true;
      });
    pending = tracked;
    return tracked;
  };
  const state = {
    admitted,
    finish,
    cleanup,
    ended: false,
    track,
    run<T>(
      kind: "direct" | "delegated",
      operation: (fence: UpdateRecoveryFence) => Promise<T>,
      timeout?: number,
    ) {
      return track(runWithExecutorFence(kind, operation, timeout));
    },
    direct<T>(operation: (executor: UpdateCommandExecutor) => Promise<T>) {
      return track(withExecutor("run", operation));
    },
    async check(check: () => void | Promise<void>, child?: () => Promise<unknown> | undefined) {
      try {
        await admitted.promise;
        await setImmediate();
        await check();
      } finally {
        finish.resolve();
        cleanup.resolve(cleanupResult);
        await Promise.allSettled([pending, child?.()]);
      }
    },
  };
  return state;
}
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
  root = fs.realpathSync(dirs.make("update-settlement-"));
  boundaries.databasePath = path.join(root, "leases.sqlite");
  rows.clear();
  boundaries.runtime.mockReset();
  const current = (candidate: ManagedHandoffParent) => rows.get(candidate.key) === candidate;
  const releaseAll: SettlementStore["releaseAll"] = (leases) => {
    if (!leases.every(current)) {
      return false;
    }
    for (const candidate of leases) {
      rows.delete(candidate.key);
    }
    return true;
  };
  // Controlled lease boundary: these cases prove async executor settlement.
  // Native store tests own physical identity, transactional CAS and v4 cancellation.
  const store: SettlementStore = {
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
      const incumbent = rows.get(key);
      if (incumbent) {
        return { kind: "busy", owner: incumbent.owner };
      }
      const acquired = lease(key, owner);
      rows.set(key, acquired);
      return { kind: "acquired", lease: acquired };
    },
    release: (candidate: ManagedHandoffLease) => current(candidate) && rows.delete(candidate.key),
    releaseAll,
    bindUpdateChildren: (children) => (children.every(current) ? children : null),
    processIdentity: (pid) => ({ pid: pid ?? process.pid, startIdentity: "synthetic" }),
    cancelUpdate: (original, retained) =>
      current(original) && (!retained || current(retained))
        ? {
            lease: original,
            retained,
            retainedOriginal: retained,
            release: (paired = []) =>
              releaseAll([original, ...(retained ? [retained] : []), ...paired]),
          }
        : null,
    current,
    owns: current,
    isProcessIdentityCurrent: () => true,
    acceptParentBoundExecutor: current,
  };
  boundaries.store.mockResolvedValue(store);
});

function runWithExecutorFence<T>(
  kind: "direct" | "delegated",
  operation: (fence: UpdateRecoveryFence) => Promise<T>,
  activationTimeoutMs?: number,
): Promise<T> {
  if (kind === "direct") {
    return withExecutor("run", async (executor) =>
      operation(await executor.enter(root, { activationTimeoutMs })),
    );
  }
  const parent = lease(root, "parent", process.ppid);
  const childKey = `${root}/.openclaw-update-child-00000000-0000-0000-0000-000000000000`;
  rows.set(root, parent);
  rows.set(childKey, { ...lease(childKey, "run"), helper: parent.executor });
  return withDelegatedExecutor(
    { runId: "run", root, databasePath: boundaries.databasePath, parent, childKey },
    "run",
    root,
    operation,
    activationTimeoutMs === undefined ? undefined : { activationTimeoutMs },
  );
}

it.each(kinds.flatMap((kind) => [false, true].map((rejects) => ({ kind, rejects }))))(
  "lets the admitted $kind child finish before stopping its operation scope (rejects: $rejects)",
  async ({ kind, rejects }) => {
    const state = settlement();
    const { admitted, finish } = state;
    const original = new Error("operation failed after child admission");
    let signal: AbortSignal | undefined;
    let child: Promise<unknown> | undefined;
    const work = state.run(kind, async (fence) => {
      child = withChild(fence, root, async (_grant, bind) => {
        bind(process.pid + 1);
        signal = resolveCommandProcessSignal();
        admitted.resolve();
        await finish.promise;
        signal!.throwIfAborted();
        return "child finished";
      });
      void child.catch((error: unknown) => admitted.reject(error));
      await admitted.promise;
      if (rejects) {
        throw original;
      }
      return "operation finished";
    });
    await state.check(
      () => {
        expect([state.ended, rows.has(root), signal?.aborted]).toEqual([false, true, false]);
      },
      () => child,
    );
    await expect(child).resolves.toBe("child finished");
    expect(await work).toBe(rejects ? original : "operation finished");
    expect(rows.size).toBe(kind === "direct" ? 0 : 2);
  },
);

it.each(cleanupCases)(
  "cancels the admitted $kind child at its activation deadline and joins $cleanupResult cleanup",
  async ({ kind, cleanupResult }) => {
    fakeTimers();
    const state = settlement(cleanupResult);
    const { admitted, cleanup } = state;
    const cancelled = createDeferredCore();
    let signal: AbortSignal | undefined;
    let child: Promise<unknown> | undefined;
    const work = state.run(
      kind,
      async (fence) => {
        child = withChild(fence, root, async (_grant, bind) => {
          bind(process.pid + 1);
          signal = resolveCommandProcessSignal();
          retainCommandProcessCleanup(cleanup.promise);
          signal!.addEventListener("abort", () => cancelled.resolve(), { once: true });
          admitted.resolve();
          await cancelled.promise;
          throw signal!.reason;
        });
        void child.catch((error: unknown) => admitted.reject(error));
        await admitted.promise;
        return "operation finished";
      },
      1000,
    );
    await state.check(
      async () => {
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        await cancelled.promise;
        expect(signal?.reason).toBeInstanceOf(UpdateActivationTimeoutError);
        expect([state.ended, rows.size]).toEqual([false, kind === "direct" ? 2 : 3]);
        await vi.advanceTimersByTimeAsync(1000);
        expect([state.ended, rows.size]).toEqual([false, kind === "direct" ? 2 : 3]);
      },
      () => child,
    );
    await setImmediate();
    const error = await work;
    const timeout = collectNestedErrorCandidates(error).find(
      (candidate) => candidate instanceof UpdateActivationTimeoutError,
    );
    expect(timeout).toBe(signal!.reason);
    expect(timeout).toMatchObject({ root, timeoutMs: 1000, reason: "update-activation-timeout" });
    expect(hasCleanupError(error)).toBe(cleanupResult === "uncertain");
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

it.each(kinds)("delivers a bounded %s timeout while its callback remains pending", async (kind) => {
  fakeTimers();
  const state = settlement();
  const { admitted, finish } = state;
  let signal: AbortSignal | undefined;
  const work = state.run(
    kind,
    async () => {
      signal = resolveCommandProcessSignal();
      admitted.resolve();
      await finish.promise;
      signal!.throwIfAborted();
    },
    1000,
  );
  try {
    await admitted.promise;
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.ended).toBe(true);
    expect(await work).toBe(signal!.reason);
    expect(await work).toBeInstanceOf(UpdateActivationTimeoutError);
    expect(rows.size).toBe(kind === "direct" ? 1 : 2);
  } finally {
    finish.resolve();
    await work;
    await setImmediate();
  }
  expect(rows.size).toBe(kind === "direct" ? 0 : 2);
});

it.each(cleanupCases)(
  "retains $kind authority until command cleanup reports $cleanupResult",
  async ({ kind, cleanupResult }) => {
    const state = settlement(cleanupResult);
    const { admitted, cleanup } = state;
    const original = new Error("operation cancelled");
    let saved: UpdateCommandExecutor | undefined;
    let fence: UpdateRecoveryFence | undefined;
    const operation = async (current: UpdateRecoveryFence) => {
      fence = current;
      retainCommandProcessCleanup(cleanup.promise);
      admitted.resolve();
      if (kind === "direct") {
        throw original;
      }
      return "complete";
    };
    const work = state.track(
      kind === "direct"
        ? withExecutor("run", async (executor) => {
            saved = executor;
            return operation(await executor.enter(root));
          })
        : runWithExecutorFence(kind, operation),
    );
    await state.check(() => {
      expect(rows.has(root)).toBe(true);
      expect(() => captureAuthority(fence!)).not.toThrow();
    });
    const error = await work;
    expect(hasCleanupError(error)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "forced") {
      expect(error).toBe(kind === "direct" ? original : "complete");
    }
    if (kind === "direct") {
      expect(rows.has(root)).toBe(cleanupResult === "uncertain");
      expect(fence!.assertCurrent).toThrow("no longer current");
      await expect(saved!.enter(root)).rejects.toThrow("closed or busy");
    } else {
      expect(fence!.assertCurrent).toThrow("no longer has permission");
      expect(rows.size).toBe(2);
    }
  },
);

it.each(cleanupResults)(
  "retains child lineage before startup binding until cleanup reports %s",
  async (cleanupResult) => {
    const state = settlement(cleanupResult);
    const { admitted, cleanup } = state;
    const original = new Error("startup cancelled");
    const candidateRoot = path.join(root, "candidate");
    let fence: UpdateRecoveryFence | undefined;
    let child: Promise<unknown> | undefined;
    const work = state.direct(async (executor) => {
      fence = await executor.enter(root);
      child = withChild(fence, candidateRoot, async () => {
        retainCommandProcessCleanup(cleanup.promise);
        admitted.resolve();
        throw original;
      });
      await child;
    });
    await state.check(
      () => {
        expect(rows.size).toBe(4);
        expect(fence!.assertCurrent).toThrow("still running");
      },
      () => child,
    );
    const error = await work;
    expect(hasCleanupError(error)).toBe(cleanupResult === "uncertain");
    expect(rows.size).toBe(cleanupResult === "uncertain" ? 4 : 0);
    if (cleanupResult === "forced") {
      expect(error).toBe(original);
    }
    await expect(withChild(fence!, candidateRoot, async () => {})).rejects.toThrow("live executor");
  },
);

it.each(cleanupResults)(
  "settles a failed runtime probe before preflight handoff release (%s)",
  async (cleanupResult) => {
    const fallbackNodeRunner = path.join(root, "replacement-node");
    fs.writeFileSync(fallbackNodeRunner, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const state = settlement(cleanupResult);
    const { admitted, cleanup } = state;
    let handedOff = false;
    boundaries.runtime
      .mockImplementationOnce(async () => {
        retainCommandProcessCleanup(cleanup.promise);
        admitted.resolve();
        return { status: "probe-failed", error: new Error("configured runtime probe timed out") };
      })
      .mockResolvedValueOnce({ status: "supported", version: "24.16.0" });
    const work = state.direct(async (executor) => {
      const fence = await executor.enter(root, { preflight: true });
      const runtime = await resolvePackageRuntimePreflight({
        root,
        target: { version: "2026.9.17", nodeEngine: ">=24.16.0" },
        fallbackNodeRunner,
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
      releasePreflight(fence);
      handedOff = true;
    });
    await state.check(() => {
      expect({ handedOff, leased: rows.has(root) }).toEqual({ handedOff: false, leased: true });
    });
    expect(hasCleanupError(await work)).toBe(cleanupResult === "uncertain");
    expect(handedOff).toBe(cleanupResult === "forced");
    expect(rows.has(root)).toBe(cleanupResult === "uncertain");
  },
);

it("preserves activation timeout provenance without a cause cycle after uncertain cleanup", async () => {
  fakeTimers();
  const deadline = createUpdateOperationDeadline();
  const state = settlement();
  const { admitted } = state;
  const cancelled = createDeferredCore();
  const work = state.track(
    deadline.run(async () => {
      deadline.start(new UpdateActivationTimeoutError(root, 1000), 1000);
      admitted.resolve();
      await cancelled.promise;
      throw new CleanupError({ cause: deadline.signal.reason });
    }),
  );
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
  expect(result).not.toBe(deadline.signal.reason);
  expect(hasCleanupError(result)).toBe(true);
  expect(collectNestedErrorCandidates(result)).toEqual(
    expect.arrayContaining([deadline.signal.reason, expect.any(CleanupError)]),
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
});

it.each([
  { kind: "direct", cleanupResult: "forced" },
  { kind: "direct", cleanupResult: "uncertain" },
  { kind: "delegated", cleanupResult: "forced" },
  { kind: "delegated", cleanupResult: "uncertain" },
] as const)(
  "joins $kind terminal preparation before release ($cleanupResult)",
  async ({ kind, cleanupResult }) => {
    const entered = createDeferredCore();
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    const operationJoined = createDeferredCore();
    const original = new Error("original update failure");
    const preparationFailure = new Error("report preparation failed");
    let calls = 0;
    let finished = false;
    const work = runWithExecutorFence(kind, async (fence) => {
      // A cleanup admitted by the operation must join before preparation starts.
      retainCommandProcessCleanup(operationJoined.promise);
      registerUpdateCommandTerminalPreparation(fence, "run", async (failure) => {
        expect(failure).toBe(original);
        calls++;
        retainCommandProcessCleanup(cleanup.promise);
        entered.resolve();
        throw preparationFailure;
      });
      throw original;
    })
      .catch((error: unknown) => {
        entered.reject(error);
        return error;
      })
      .finally(() => {
        finished = true;
      });
    try {
      await setImmediate();
      expect(calls).toBe(0);
      operationJoined.resolve();
      await entered.promise;
      await setImmediate();
      expect(finished).toBe(false);
      expect(rows.has(root)).toBe(true);
    } finally {
      operationJoined.resolve();
      cleanup.resolve(cleanupResult);
      await work;
    }
    const error = await work;
    expect(calls).toBe(1);
    expect(collectNestedErrorCandidates(error)).toContain(original);
    expect(collectNestedErrorCandidates(error)).toContain(preparationFailure);
    expect(hasCleanupError(error)).toBe(cleanupResult === "uncertain");
    expect(rows.size).toBe(kind === "delegated" ? 2 : cleanupResult === "uncertain" ? 1 : 0);
  },
);

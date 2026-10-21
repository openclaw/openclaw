import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import { materializeProjectClone } from "./project-clone.js";
import type { ProjectRegistryRecord } from "./project-registry.types.js";
type LeaseRun = (lease: OpenClawStateLeaseContext) => Promise<unknown>;

const fixture = vi.hoisted(() => {
  const lease = () =>
    ({
      signal: new AbortController().signal,
      assertOwned: vi.fn(),
      assertOwnedInTransaction: vi.fn(),
    }) satisfies OpenClawStateLeaseContext;
  return {
    originLease: lease(),
    checkoutLease: lease(),
    checkouts: new Set<string>(),
    clone: vi.fn<(input: { target: string }) => Promise<void>>(),
    remove: vi.fn<(target: string) => Promise<void>>(),
    execute: vi.fn<() => Promise<ProjectRegistryRecord>>(),
    finishWorker: vi.fn<() => void>(),
    finishCheckout: vi.fn<() => void>(),
  };
});

vi.mock("node:fs/promises", () => ({ default: { rm: fixture.remove } }));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({
    admission: { databasePath: "/synthetic/state/openclaw.sqlite" },
  }),
}));

// mock-isolation: synthetic lease callbacks must not acquire the operator state lease.
vi.mock("../state/openclaw-state-lease.js", () => ({
  withOpenClawStateLease: async (_options: unknown, run: LeaseRun) => run(fixture.originLease),
}));

// mock-isolation: model checkout settlement without touching host projects or Git state.
vi.mock("./project-checkout.js", () => ({
  ProjectCheckoutError: class extends Error {},
  resolveProjectDirectory: async (root: string) => root,
  resolveProjectCheckout: async (root: string) => ({ path: root, repoRoot: root }),
  withProjectCheckoutLifecycle: async (_root: string, _options: unknown, run: LeaseRun) => {
    const result = await run(fixture.checkoutLease);
    fixture.finishCheckout();
    return result;
  },
}));

vi.mock("./project-registry.js", () => ({ listProjectRegistry: async () => [] }));
// mock-isolation: clone outcomes are synthetic and must not run Git or access the network.
vi.mock("./project-clone-runtime.js", () => ({ cloneProjectCheckout: fixture.clone }));

vi.mock("../state/openclaw-state-lease-worker-operation.js", () => ({
  runWithOpenClawStateLeaseWorker: async (
    _lease: OpenClawStateLeaseContext,
    _context: unknown,
    operation: (
      scope: { execute: typeof fixture.execute },
      identity: { scope: string; key: string; owner: string },
    ) => Promise<unknown>,
  ) => {
    const result = await operation(
      { execute: fixture.execute },
      { scope: "projects.checkout", key: "synthetic-checkout", owner: "synthetic-owner" },
    );
    fixture.finishWorker();
    return result;
  },
}));

const materialize = () =>
  materializeProjectClone(
    { cfg: {}, gitUrl: "https://github.com/example/project.git" },
    { env: { OPENCLAW_STATE_DIR: "/synthetic/state" } },
  );

beforeEach(() => {
  vi.resetAllMocks();
  fixture.checkouts.clear();
  fixture.clone.mockImplementation(async ({ target }) => void fixture.checkouts.add(target));
  fixture.remove.mockImplementation(async (target) => void fixture.checkouts.delete(target));
  fixture.execute.mockImplementation(async () => {
    const repoRoot = [...fixture.checkouts][0];
    if (!repoRoot) {
      throw new Error("Expected a produced checkout");
    }
    return {
      id: "project",
      displayName: "project",
      repoRoot,
      originUrl: "https://github.com/example/project.git",
      source: "cloned",
    };
  });
});

it("returns an acknowledged registration and retains its checkout", async () => {
  const project = await materialize();
  expect(fixture.checkouts).toEqual(new Set([project.repoRoot]));
  expect(fixture.remove).not.toHaveBeenCalled();
});

it.each(["unknown", "worker", "finalizer", "precommit", "removal", "origin", "checkout"] as const)(
  "settles registration after %s failure",
  async (stage) => {
    let failure: Error = new Error(`${stage} failed`);
    if (stage === "unknown") {
      const unknown = Object.assign(new Error("Worker result unavailable"), {
        name: "SqliteWorkerError",
        code: "outcome-unknown",
      });
      failure = new AggregateError([unknown, new Error("Retirement failed")], "Cleanup failed");
    }
    const fail = () => {
      throw failure;
    };
    if (stage === "worker" || stage === "finalizer") {
      const finish = stage === "worker" ? fixture.finishWorker : fixture.finishCheckout;
      finish.mockImplementation(fail);
    } else {
      fixture.execute.mockImplementation(async () => {
        if (stage === "origin" || stage === "checkout") {
          const lease = stage === "origin" ? fixture.originLease : fixture.checkoutLease;
          lease.assertOwned.mockImplementation(() => {
            throw new Error("Owner is no longer current");
          });
        }
        return fail();
      });
    }
    if (stage === "removal") {
      fixture.remove.mockRejectedValue(new Error("Checkout removal failed"));
    }
    await expect(materialize()).rejects.toBe(failure);
    expect(fixture.checkouts.size).toBe(stage === "precommit" ? 0 : 1);
    const removals = stage === "precommit" || stage === "removal" ? 1 : 0;
    expect(fixture.remove).toHaveBeenCalledTimes(removals);
  },
);

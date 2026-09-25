import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import { materializeProjectClone } from "./project-clone.js";
import type { ProjectRegistryRecord } from "./project-registry.kernel.js";

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
    resolveCheckout: vi.fn<(root: string) => Promise<{ path: string; repoRoot: string }>>(),
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

vi.mock("../state/openclaw-state-lease.js", () => ({
  withOpenClawStateLease: async (
    _options: unknown,
    run: (lease: OpenClawStateLeaseContext) => Promise<unknown>,
  ) => run(fixture.originLease),
}));

vi.mock("./project-checkout.js", () => ({
  ProjectCheckoutError: class extends Error {},
  resolveProjectDirectory: async (root: string) => root,
  resolveProjectCheckout: fixture.resolveCheckout,
  withProjectCheckoutLifecycle: async (
    _root: string,
    _options: unknown,
    run: (lease: OpenClawStateLeaseContext) => Promise<unknown>,
  ) => {
    const result = await run(fixture.checkoutLease);
    fixture.finishCheckout();
    return result;
  },
}));

vi.mock("./project-registry.js", () => ({ listProjectRegistry: async () => [] }));

vi.mock("./project-clone-runtime.js", () => ({
  cloneProjectCheckout: fixture.clone,
}));

vi.mock("../state/openclaw-state-lease-worker-storage.js", () => ({
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

function materialize() {
  return materializeProjectClone(
    { cfg: {}, gitUrl: "https://github.com/example/project.git" },
    { env: { OPENCLAW_STATE_DIR: "/synthetic/state" } },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.checkouts.clear();
  fixture.clone.mockImplementation(async ({ target }) => {
    fixture.checkouts.add(target);
  });
  fixture.remove.mockImplementation(async (target) => {
    fixture.checkouts.delete(target);
  });
  fixture.resolveCheckout.mockImplementation(async (root) => ({ path: root, repoRoot: root }));
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

describe("project clone registration cleanup", () => {
  it("returns an acknowledged registration and retains its checkout", async () => {
    const project = await materialize();
    expect(fixture.checkouts).toEqual(new Set([project.repoRoot]));
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("retains the checkout for a plain wire-coded unknown outcome inside a cleanup aggregate", async () => {
    const unknown = Object.assign(new Error("Worker result was unavailable"), {
      name: "SqliteWorkerError",
      code: "outcome-unknown",
    });
    const failure = new AggregateError([unknown, new Error("Retirement failed")], "Cleanup failed");
    fixture.execute.mockRejectedValue(failure);

    await expect(materialize()).rejects.toBe(failure);
    expect(fixture.checkouts.size).toBe(1);
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it.each(["worker", "checkout"] as const)(
    "retains an acknowledged checkout when %s finalization fails",
    async (owner) => {
      const failure = new Error(`${owner} finalization failed`);
      const finish = owner === "worker" ? fixture.finishWorker : fixture.finishCheckout;
      finish.mockImplementation(() => {
        throw failure;
      });

      await expect(materialize()).rejects.toBe(failure);
      expect(fixture.checkouts.size).toBe(1);
      expect(fixture.remove).not.toHaveBeenCalled();
    },
  );

  it("removes the produced checkout after a definite precommit failure", async () => {
    const failure = new Error("Insert was refused before execution");
    fixture.execute.mockRejectedValue(failure);

    await expect(materialize()).rejects.toBe(failure);
    expect(fixture.checkouts.size).toBe(0);
    expect(fixture.remove).toHaveBeenCalledOnce();
  });

  it("removes a produced checkout when registration preparation rejects it", async () => {
    const failure = new Error("Project checkout has no commits");
    fixture.resolveCheckout.mockRejectedValue(failure);

    await expect(materialize()).rejects.toBe(failure);
    expect(fixture.checkouts.size).toBe(0);
    expect(fixture.remove).toHaveBeenCalledOnce();
  });

  it("preserves the registration error when checkout removal fails", async () => {
    const failure = new Error("Insert was refused before execution");
    fixture.execute.mockRejectedValue(failure);
    fixture.remove.mockRejectedValue(new Error("Checkout removal failed"));

    await expect(materialize()).rejects.toBe(failure);
    expect(fixture.checkouts.size).toBe(1);
    expect(fixture.remove).toHaveBeenCalledOnce();
  });

  it.each(["origin", "checkout"] as const)(
    "preserves the registration error and checkout when its %s owner cannot authorize cleanup",
    async (owner) => {
      const failure = new Error("Insert was refused before execution");
      const lease = owner === "origin" ? fixture.originLease : fixture.checkoutLease;
      fixture.execute.mockImplementation(async () => {
        lease.assertOwned.mockImplementation(() => {
          throw new Error("Owner is no longer current");
        });
        throw failure;
      });

      await expect(materialize()).rejects.toBe(failure);
      expect(fixture.checkouts.size).toBe(1);
      expect(fixture.remove).not.toHaveBeenCalled();
    },
  );
});

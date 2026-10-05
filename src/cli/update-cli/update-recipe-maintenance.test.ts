import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { UPDATE_RECIPE_MAINTENANCE_CAPABILITY } from "./update-recipe-maintenance-contract.js";
import { runUpdateRecipeMaintenanceReceiver } from "./update-recipe-maintenance.js";

const fixture = vi.hoisted(() => ({
  events: [] as string[],
  nativeCurrent: true,
  lockCurrent: true,
  expectedVersions: [{ path: "/state/state/openclaw.sqlite", userVersion: 42 }],
  inspect: vi.fn(),
  ready: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
  release: vi.fn(),
  delegate: vi.fn(),
  owner: vi.fn(),
  captured: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ realpath: async (pathname: string) => pathname }));
vi.mock("../../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => "/target",
}));
vi.mock("../../infra/update-install-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-install-root.js")>()),
  resolveUpdateInstallRoot: (root: string) => root,
}));
vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  resolveStateDir: () => "/state",
}));
vi.mock("../../state/openclaw-state-db.paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-db.paths.js")>()),
  resolveOpenClawStateSqlitePath: () => "/state/state/openclaw.sqlite",
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotWithPluginMetadata: async () => ({
    snapshot: { sourceConfig: { plugins: { enabled: false } } },
  }),
}));
vi.mock("../../state/openclaw-state-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-db-readonly.js")>()),
  withArtifactPreservingStateReads: (run: () => unknown) => run(),
}));
vi.mock("../../infra/update-candidate-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-candidate-state.js")>()),
  readUpdateStateSchemaVersions: fixture.inspect,
}));
vi.mock("../../state/openclaw-database-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-database-preflight.js")>()),
  assertOpenClawDatabasesReady: fixture.ready,
}));
vi.mock("./update-command-executor-delegated.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-executor-delegated.js")>()),
  withDelegatedUpdateCommandExecutor: fixture.delegate,
}));
vi.mock("./update-command-execution-guards.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-execution-guards.js")>()),
  createUpdateCommandExecutionGuards: () => ({ captureWriteOptions: fixture.captured }),
}));
vi.mock("../../infra/upgrade-recipes/maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/upgrade-recipes/maintenance.js")>()),
  createUpgradeRecipeMaintenanceOwner: fixture.owner,
}));
vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  acquireGatewayLock: async () => {
    fixture.events.push("state-acquired");
    return {
      run: (run: () => unknown) => run(),
      assertCurrent: () => {
        if (!fixture.lockCurrent) {
          throw new Error("state owner lost");
        }
      },
      release: fixture.release,
    };
  },
}));
vi.mock("../../gateway/server-upgrade-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/server-upgrade-maintenance.js")>()),
  startGatewayUpgradeMaintenance: fixture.start,
}));

const input = () => ({
  capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY,
  executor: {
    runId: "original-run",
    root: "/target",
    databasePath: "/native/leases.sqlite",
    childKey: "child",
    originalChildKey: "original-child",
    parent: {},
    originalParent: {},
    spawner: {},
    databaseIdentity: {},
  },
  binding: {
    protocol: 1,
    runId: "original-run",
    planDigest: "b".repeat(64),
    targetArtifactId: "target-artifact",
    installationKey: "/target",
    stateRootKey: "/state",
  },
  expected: {
    version: "target-version",
    buildId: "target-build",
    runtimeExecutable: "/private/node",
    installationRoot: "/target",
    stateRoot: "/state",
    configPath: "/state/openclaw.json",
    configHash: "a".repeat(64),
    configSourceDigest: "c".repeat(64),
    profile: "default",
  },
  port: 18789,
  timeoutMs: 10000,
  stateVersions: fixture.expectedVersions,
});

beforeEach(() => {
  fixture.events = [];
  fixture.nativeCurrent = true;
  fixture.lockCurrent = true;
  fixture.inspect.mockImplementation(async () => fixture.expectedVersions);
  fixture.ready.mockResolvedValue(undefined);
  fixture.delegate.mockImplementation(async (_grant, _runId, _root, run) => {
    fixture.events.push("native-admitted");
    if (!fixture.nativeCurrent) {
      throw new Error("native owner lost");
    }
    return await run({
      assertCurrent: () => {
        if (!fixture.nativeCurrent) {
          throw new Error("native owner lost");
        }
      },
    });
  });
  fixture.captured.mockImplementation(() => ({
    assertCurrent: () => {
      if (!fixture.nativeCurrent) {
        throw new Error("native owner lost");
      }
    },
    retainSettlement: vi.fn(),
  }));
  fixture.owner.mockImplementation((binding, options) => ({
    binding,
    assertCurrent: options.assertCurrent,
  }));
  fixture.close.mockImplementation(async () => fixture.events.push("kernel-closed"));
  fixture.release.mockImplementation(async () => fixture.events.push("state-released"));
  fixture.start.mockImplementation(async (_port, startup, options) => {
    expect(options.gatewayStateOwner).toBeDefined();
    startup.owner.assertCurrent();
    fixture.events.push("target-started");
    return {
      commit: async () => {
        await startup.verifyStatePostconditions();
        startup.owner.assertCurrent();
        fixture.events.push("target-committed");
        return { binding: startup.owner.binding, phase: "committed", revision: 3, updatedAtMs: 1 };
      },
      close: fixture.close,
    };
  });
});
afterEach(() => vi.clearAllMocks());

it("uses original native custody and target state ownership, settling before returning to parent", async () => {
  const result = await runUpdateRecipeMaintenanceReceiver(input());
  expect(result).toMatchObject({ outcome: "target-committed", managedServiceVerified: false });
  expect(fixture.events).toEqual([
    "native-admitted",
    "state-acquired",
    "target-started",
    "target-committed",
    "kernel-closed",
    "state-released",
  ]);
  expect(fixture.inspect).toHaveBeenCalledWith(
    expect.objectContaining({ root: "/target", stateDir: "/state" }),
  );
  expect(fixture.ready).toHaveBeenCalledOnce();
});

it("cannot manufacture receiver authority from a receipt or environment selection", async () => {
  fixture.nativeCurrent = false;
  await expect(runUpdateRecipeMaintenanceReceiver(input())).rejects.toThrow("native owner lost");
  expect(fixture.owner).not.toHaveBeenCalled();
  expect(fixture.start).not.toHaveBeenCalled();
  expect(fixture.release).not.toHaveBeenCalled();
});

it("rejects another loaded target before consuming any delegated authority", async () => {
  const substituted = input();
  substituted.expected.installationRoot = "/runner";
  await expect(runUpdateRecipeMaintenanceReceiver(substituted)).rejects.toThrow(
    "selected target/state owner",
  );
  expect(fixture.delegate).not.toHaveBeenCalled();
  expect(fixture.start).not.toHaveBeenCalled();
});

it("verifies real current state instead of treating the plan or receipt as a postcondition", async () => {
  fixture.inspect.mockResolvedValue([{ path: "/state/state/openclaw.sqlite", userVersion: 43 }]);
  await expect(runUpdateRecipeMaintenanceReceiver(input())).rejects.toThrow("contracts differ");
  expect(fixture.events).not.toContain("target-committed");
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.release).toHaveBeenCalledOnce();
});

it("rechecks native authority after awaited state inspection and refuses activation", async () => {
  fixture.inspect.mockImplementation(async () => {
    fixture.nativeCurrent = false;
    return fixture.expectedVersions;
  });
  await expect(runUpdateRecipeMaintenanceReceiver(input())).rejects.toThrow();
  expect(fixture.events).not.toContain("target-committed");
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.release).toHaveBeenCalledOnce();
});

it("keeps physical state exclusion when bounded kernel shutdown is uncertain", async () => {
  fixture.close.mockRejectedValue(new Error("kernel did not settle"));
  await expect(runUpdateRecipeMaintenanceReceiver(input())).rejects.toThrow("settlement failed");
  expect(fixture.release).not.toHaveBeenCalled();
});

it("requires explicit new receiver capability and modern lineage", async () => {
  const old = input();
  await expect(
    runUpdateRecipeMaintenanceReceiver({ ...old, capability: "admission-v1" }),
  ).rejects.toThrow();
  await expect(
    runUpdateRecipeMaintenanceReceiver({ ...old, executor: { runId: "original-run" } }),
  ).rejects.toThrow();
  expect(fixture.delegate).not.toHaveBeenCalled();
});

it("joins accepted receipt writes even when kernel teardown rejects", async () => {
  const pendingWrite = createDeferredCore();
  const teardown = createDeferredCore();
  fixture.owner.mockImplementation((binding, options) => {
    options.retainSettlement(pendingWrite.promise);
    return { binding, assertCurrent: options.assertCurrent };
  });
  fixture.close.mockImplementation(async () => {
    teardown.resolve();
    throw new Error("kernel teardown failed");
  });
  let finished = false;
  const execution = runUpdateRecipeMaintenanceReceiver(input()).finally(() => {
    finished = true;
  });
  // Attach the error assertion before allowing completion, avoiding an
  // unhandled rejection while observing the cleanup barrier.
  const outcome = expect(execution).rejects.toThrow("settlement failed");
  await teardown.promise;
  expect(finished).toBe(false);
  expect(fixture.release).not.toHaveBeenCalled();
  pendingWrite.resolve();
  await outcome;
  expect(fixture.release).not.toHaveBeenCalled();
});

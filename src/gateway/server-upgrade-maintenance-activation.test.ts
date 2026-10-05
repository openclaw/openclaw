import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveGatewayUpgradeMaintenanceConfigIdentity } from "../infra/upgrade-recipes/maintenance-config.js";
import type { UpgradeRecipeMaintenanceReceipt } from "../infra/upgrade-recipes/maintenance-contract.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import {
  beginGatewayUpgradeMaintenance,
  getGatewayUpgradeMaintenanceBinding,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  startGatewayUpgradeMaintenance,
  type GatewayUpgradeMaintenanceStartup,
} from "./server-upgrade-maintenance.js";

const fixture = vi.hoisted(() => ({
  root: "",
  config: vi.fn(),
  start: vi.fn(),
}));
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  readConfigFileSnapshotWithPluginMetadata: fixture.config,
}));
vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  resolveStateDir: () => fixture.root,
}));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => fixture.root,
}));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  VERSION: "fixture",
  resolveRuntimeServiceBuildId: () => "fixture-build",
}));
vi.mock("../state/openclaw-state-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-readonly.js")>()),
  withArtifactPreservingStateReads: (run: () => unknown) => run(),
}));
vi.mock("./server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server.js")>()),
  startGatewayServer: fixture.start,
}));

let startup: GatewayUpgradeMaintenanceStartup;
let receipt: UpgradeRecipeMaintenanceReceipt;
const normalClose = vi.fn(async () => {
  resetGatewayWorkAdmission();
});
beforeEach(async () => {
  fixture.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "upgrade-activation-")));
  const configPath = path.join(fixture.root, "openclaw.json");
  await fs.writeFile(configPath, "{}");
  vi.stubEnv("OPENCLAW_PROFILE", "default");
  receipt = {
    binding: {
      protocol: 1,
      runId: "run",
      planDigest: "a".repeat(64),
      targetArtifactId: "target",
      installationKey: fixture.root,
      stateRootKey: fixture.root,
    },
    phase: "maintenance-required",
    revision: 1,
    updatedAtMs: 1,
  };
  const owner = {
    binding: receipt.binding,
    assertCurrent: vi.fn(),
    read: vi.fn(async () => receipt),
    verifyCommitIntent: vi.fn(async () => {
      expect(receipt.phase).toBe("commit-intent");
    }),
    requireMaintenance: vi.fn(),
    recordCommitIntent: vi.fn(async () => {
      receipt = { ...receipt, phase: "commit-intent", revision: 2 };
      return receipt;
    }),
    recordCommitted: vi.fn(async () => {
      receipt = { ...receipt, phase: "committed", revision: 3 };
      return receipt;
    }),
  };
  startup = {
    owner,
    qualification: "plugin-free",
    expected: {
      version: "fixture",
      buildId: "fixture-build",
      runtimeExecutable: await fs.realpath(process.execPath),
      installationRoot: fixture.root,
      stateRoot: fixture.root,
      configPath,
      ...resolveGatewayUpgradeMaintenanceConfigIdentity({
        hash: "a".repeat(64),
        sourceConfig: { plugins: { enabled: false } },
      }),
      profile: "default",
    },
    verifyStatePostconditions: vi.fn(async () => {}),
  };
  fixture.config.mockImplementation(async () => ({
    snapshot: {
      valid: true,
      exists: true,
      path: configPath,
      hash: "a".repeat(64),
      sourceConfig: { plugins: { enabled: false } },
    },
  }));
  fixture.start.mockImplementation(async (_port, options) => ({
    startupSettled: Promise.resolve(),
    close: options.upgradeMaintenance
      ? async () => {
          resetGatewayWorkAdmission();
        }
      : normalClose,
    getUpgradeMaintenanceReadiness: () => ({ ready: true, failing: [] }),
  }));
});
afterEach(async () => {
  resetGatewayWorkAdmission();
  if (getGatewayUpgradeMaintenanceBinding()) {
    startup.owner.assertCurrent = () => {};
    startup.owner.verifyCommitIntent = async () => {};
    await beginGatewayUpgradeMaintenance(startup.owner).commit();
  }
  resetGatewayWorkAdmission();
  await fs.rm(fixture.root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const options = () =>
  ({ gatewayStateOwner: {} }) as unknown as Parameters<typeof startGatewayUpgradeMaintenance>[2];

it("retains commit intent and closes new admission when the terminal receipt fails", async () => {
  const server = await startGatewayUpgradeMaintenance(0, startup, options());
  startup.owner.recordCommitted = vi.fn(async () => {
    // Exercise the actual interval after activation, not only a closed-gate helper.
    const accepted = tryBeginGatewayRootWorkAdmission();
    expect(accepted).not.toBeNull();
    accepted?.release();
    throw new Error("receipt failed");
  });
  await expect(server.commit()).rejects.toThrow("receipt failed");
  expect(receipt.phase).toBe("commit-intent");
  expect(normalClose).toHaveBeenCalledOnce();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
});

it("does not activate configuration changed during durable commit preparation", async () => {
  const server = await startGatewayUpgradeMaintenance(0, startup, options());
  startup.owner.recordCommitIntent = vi.fn(async () => {
    receipt = { ...receipt, phase: "commit-intent", revision: 2 };
    fixture.config.mockImplementation(async () => ({
      snapshot: {
        valid: true,
        exists: true,
        path: startup.expected.configPath,
        hash: "b".repeat(64),
        sourceConfig: { plugins: { enabled: true } },
      },
    }));
    return receipt;
  });
  await expect(server.commit()).rejects.toThrow("plugins must be explicitly disabled");
  expect(fixture.start).toHaveBeenCalledOnce();
  expect(receipt.phase).toBe("commit-intent");
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
});

it("activates only the checked configuration snapshot and records completion", async () => {
  const server = await startGatewayUpgradeMaintenance(0, startup, options());
  await expect(server.commit()).resolves.toMatchObject({ phase: "committed" });
  expect(fixture.start.mock.calls[1]?.[1].startupConfigSnapshotRead.snapshot.hash).toBe(
    "a".repeat(64),
  );
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
  await server.close();
});

it("resumes original commit intent after admitted writes without replaying intent or rewinding state", async () => {
  const statePath = path.join(fixture.root, "post-admission-state");
  const server = await startGatewayUpgradeMaintenance(0, startup, options());
  const recordCommitted = startup.owner.recordCommitted;
  startup.owner.recordCommitted = vi.fn(async () => {
    const accepted = tryBeginGatewayRootWorkAdmission();
    expect(accepted).not.toBeNull();
    await accepted!.run(() => fs.writeFile(statePath, "newer accepted state"));
    accepted!.release();
    throw new Error("terminal receipt interrupted");
  });
  await expect(server.commit()).rejects.toThrow("terminal receipt interrupted");
  expect(receipt.phase).toBe("commit-intent");
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  startup.owner.recordCommitted = recordCommitted;
  startup.verifyStatePostconditions = vi.fn(async () => {
    expect(await fs.readFile(statePath, "utf8")).toBe("newer accepted state");
  });
  const resumed = await startGatewayUpgradeMaintenance(0, startup, options());
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  await expect(resumed.commit()).resolves.toMatchObject({ phase: "committed", revision: 3 });
  expect(startup.owner.recordCommitIntent).toHaveBeenCalledOnce();
  expect(startup.verifyStatePostconditions).toHaveBeenCalledOnce();
  expect(await fs.readFile(statePath, "utf8")).toBe("newer accepted state");
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
  await resumed.close();
});

it("refuses original-intent recovery without current executor authority", async () => {
  receipt = { ...receipt, phase: "commit-intent", revision: 2 };
  startup.owner.assertCurrent = vi.fn(() => {
    throw new Error("original executor lost");
  });
  await expect(startGatewayUpgradeMaintenance(0, startup, options())).rejects.toThrow(
    "original executor lost",
  );
  expect(fixture.start).not.toHaveBeenCalled();
  expect(receipt.phase).toBe("commit-intent");
});

it("refuses changed approved policy on recovery even if the config-file revision is unchanged", async () => {
  receipt = { ...receipt, phase: "commit-intent", revision: 2 };
  fixture.config.mockImplementation(async () => ({
    snapshot: {
      valid: true,
      exists: true,
      path: startup.expected.configPath,
      hash: "a".repeat(64),
      sourceConfig: { plugins: { enabled: false }, gateway: { auth: { mode: "none" } } },
    },
  }));
  await expect(startGatewayUpgradeMaintenance(0, startup, options())).rejects.toThrow(
    "differs from the pinned plan",
  );
  expect(fixture.start).not.toHaveBeenCalled();
  expect(receipt.phase).toBe("commit-intent");
});

it("requires target readiness and current state verification before resumed activation", async () => {
  receipt = { ...receipt, phase: "commit-intent", revision: 2 };
  startup.verifyStatePostconditions = vi.fn(async () => {
    throw new Error("current state postcondition failed");
  });
  const resumed = await startGatewayUpgradeMaintenance(0, startup, options());
  await expect(resumed.commit()).rejects.toThrow("current state postcondition failed");
  expect(fixture.start).toHaveBeenCalledOnce();
  expect(startup.owner.recordCommitted).not.toHaveBeenCalled();
  expect(startup.owner.recordCommitIntent).not.toHaveBeenCalled();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(receipt.phase).toBe("commit-intent");
  await resumed.close();
});

it("settles a restricted recovery kernel whose startup readiness fails while keeping exclusion", async () => {
  receipt = { ...receipt, phase: "commit-intent", revision: 2 };
  const close = vi.fn(async () => resetGatewayWorkAdmission());
  fixture.start.mockImplementation(async () => ({
    startupSettled: Promise.reject(new Error("restricted startup failed")),
    close,
  }));
  await expect(startGatewayUpgradeMaintenance(0, startup, options())).rejects.toThrow(
    "restricted startup failed",
  );
  expect(close).toHaveBeenCalledOnce();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(receipt.phase).toBe("commit-intent");
});

it("marks an unsettled restricted kernel so the native receiver retains physical custody", async () => {
  receipt = { ...receipt, phase: "commit-intent", revision: 2 };
  const cleanup = new Error("kernel close failed");
  fixture.start.mockImplementation(async () => ({
    startupSettled: Promise.reject(new Error("restricted startup failed")),
    close: async () => {
      throw cleanup;
    },
  }));
  const failure = await startGatewayUpgradeMaintenance(0, startup, options()).catch(
    (error: unknown) => error,
  );
  expect(hasCommandProcessCleanupError(failure)).toBe(true);
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(receipt.phase).toBe("commit-intent");
});

it("keeps recovery excluded when the current target is not locally ready", async () => {
  receipt = { ...receipt, phase: "commit-intent", revision: 2 };
  fixture.start.mockImplementation(async () => ({
    startupSettled: Promise.resolve(),
    close: async () => resetGatewayWorkAdmission(),
    getUpgradeMaintenanceReadiness: () => ({ ready: false, failing: ["state"] }),
  }));
  const resumed = await startGatewayUpgradeMaintenance(0, startup, options());
  await expect(resumed.commit()).rejects.toThrow("readiness or business exclusion is unverified");
  expect(startup.verifyStatePostconditions).not.toHaveBeenCalled();
  expect(startup.owner.recordCommitted).not.toHaveBeenCalled();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  await resumed.close();
});

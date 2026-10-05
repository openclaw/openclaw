import { beforeEach, expect, it, vi } from "vitest";
import type { UpgradeRecipeStepReceipt } from "../../infra/upgrade-recipes/receipts-contract.js";
import {
  upgradeRecipeStepPostconditionMatches,
  upgradeRecipeStepReceiptSchema,
} from "../../infra/upgrade-recipes/receipts-contract.js";
import { createUpgradeRecipeStepReceiptRecorder } from "../../infra/upgrade-recipes/receipts.js";
import {
  prepareRecipePackagePublication,
  reconcileRecipePackagePublication,
  prepareRecipeTargetMaintenance,
  reconcileRecipeTargetMaintenance,
  prepareRecipeServiceActivation,
  reconcileRecipeServiceActivation,
  observeRecipeServiceForRecovery,
} from "./recipe-step-execution.js";
import { approvedContext } from "./update-recipe-context.test-support.js";

const mocks = vi.hoisted(() => ({
  receipts: new Map<string, UpgradeRecipeStepReceipt>(),
  state: vi.fn(),
  installation: vi.fn(),
  maintenance: vi.fn(),
  service: vi.fn(),
  serviceVerdict: vi.fn(),
  ledger: vi.fn(),
}));
vi.mock("../../config/io.factory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.factory.js")>()),
  createConfigIO: () => ({ readConfigFileSnapshot: async () => ({ config: {} }) }),
}));
vi.mock("../../infra/update-candidate-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-candidate-state.js")>()),
  readUpdateStateSchemaVersions: mocks.state,
  resolveUpdateStateContentVersion: (entry: { userVersion: number }) => entry.userVersion,
}));
vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
  getUpdateRunAsync: mocks.ledger,
}));
vi.mock("../../infra/upgrade-recipes/maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/upgrade-recipes/maintenance.js")>()),
  readUpgradeRecipeMaintenanceReceipt: mocks.maintenance,
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({}),
}));
vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  readGatewayServiceStateForUpdate: mocks.service,
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  revalidateManagedGatewayServiceAfterUpdate: mocks.serviceVerdict,
}));
vi.mock("./update-recipe-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-recipe-context.js")>()),
  assertRecipeUpdateBinding: vi.fn(),
  assertRecipeUpdateConfig: vi.fn(),
  verifyRecipeUpdateInstallation: mocks.installation,
  resolveRecipeUpdateStepCatalogFacts: async () => ({
    sourceManifestDigest: "a".repeat(64),
    targetManifestDigest: "b".repeat(64),
    steps: ["core.package-publish", "core.gateway-maintenance", "core.service-verify"].map(
      (id, index) => ({
        id,
        adapter: { id, revision: 1 },
        adapterArtifactDigest: "c".repeat(64),
        phase: ["quiesced-migrate", "postpublish-maintenance", "verify"][index],
      }),
    ),
  }),
}));
// Exercise the production receipt coordinator; only its fenced persistence port
// is in memory. This suite does not claim native custody or end-to-end proof.
vi.mock("../../infra/upgrade-recipes/receipts-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/upgrade-recipes/receipts-worker.js")>()),
  createFencedUpgradeRecipeStepReceiptRecorder: (
    binding: Parameters<typeof createUpgradeRecipeStepReceiptRecorder>[0],
    owner: Parameters<typeof createUpgradeRecipeStepReceiptRecorder>[1],
  ) =>
    createUpgradeRecipeStepReceiptRecorder(binding, {
      assertCurrent: owner.assertCurrent,
      assertEffectsSettled: owner.assertEffectsSettled,
      read: async () => mocks.receipts.get(binding.stepId) ?? null,
      record: async (input) => {
        const previous = mocks.receipts.get(binding.stepId);
        const observation = input.kind === "observation" ? input.observation : undefined;
        const receipt = upgradeRecipeStepReceiptSchema.parse({
          binding,
          phase: observation
            ? upgradeRecipeStepPostconditionMatches(binding, observation)
              ? "verified"
              : "outcome-unknown"
            : "intent",
          revision: (previous?.revision ?? 0) + 1,
          intentAtMs: 1,
          updatedAtMs: 2,
          ...(observation ? { observation } : {}),
        });
        mocks.receipts.set(binding.stepId, receipt);
        return receipt;
      },
    }),
}));
const recipe = approvedContext();
const owner = {
  env: {
    OPENCLAW_STATE_DIR: recipe.maintenance.expected.stateRoot,
    OPENCLAW_CONFIG_PATH: recipe.maintenance.expected.configPath,
    OPENCLAW_PROFILE: "default",
  },
  assertCurrent: vi.fn(),
  assertEffectsSettled: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.receipts.clear();
  mocks.serviceVerdict.mockResolvedValue({ kind: "owned", fingerprint: "1".repeat(64) });
  mocks.state.mockResolvedValue(recipe.sourceStateVersions);
  mocks.installation.mockResolvedValue({
    root: recipe.maintenance.expected.installationRoot,
    manifestDigest: "b".repeat(64),
  });
  mocks.maintenance.mockResolvedValue({
    binding: recipe.maintenance.binding,
    phase: "maintenance-required",
  });
  mocks.service.mockResolvedValue({
    env: owner.env,
    running: false,
    runtime: {
      status: "stopped",
      systemd: {
        scope: "user",
        unit: recipe.service.unitName,
        managerUid: recipe.service.managerUid,
      },
    },
  });
  mocks.ledger.mockResolvedValue({
    verification: {
      runningVersion: recipe.maintenance.expected.version,
      runningBuildId: recipe.maintenance.expected.buildId,
      port: recipe.maintenance.port,
      versionMatch: true,
      readyz: true,
      settled: true,
      serviceRunning: true,
      pid: 42,
    },
  });
});
it.each(["running", "stopped"])(
  "refuses an owned but unapproved %s service definition before recovery effects",
  async (status) => {
    mocks.service.mockResolvedValue({
      env: owner.env,
      running: status === "running",
      runtime: {
        status,
        pid: status === "running" ? 42 : undefined,
        systemd: {
          scope: recipe.service.scope,
          unit: recipe.service.unitName,
          managerUid: recipe.service.managerUid,
        },
      },
    });
    mocks.serviceVerdict.mockResolvedValue({ kind: "owned", fingerprint: "2".repeat(64) });
    await expect(observeRecipeServiceForRecovery(recipe, owner)).rejects.toThrow(
      "definition differs from explicit approval",
    );
    expect(mocks.receipts.size).toBe(0);
  },
);
it("compares the actual source state before recording publication intent", async () => {
  mocks.state.mockResolvedValue([{ ...recipe.sourceStateVersions[0], userVersion: 2 }]);
  await expect(prepareRecipePackagePublication(recipe, owner)).rejects.toThrow("before image");
  expect(mocks.receipts.size).toBe(0);
});
it("records publication intent once and refuses a fresh replay of that intent", async () => {
  await prepareRecipePackagePublication(recipe, owner);
  expect(mocks.receipts.get("core.package-publish")?.phase).toBe("intent");
  await expect(prepareRecipePackagePublication(recipe, owner)).rejects.toThrow("original owner");
  expect(mocks.receipts.get("core.package-publish")?.revision).toBe(1);
});
it("uses the observed installed manifest rather than the approved target hash", async () => {
  await prepareRecipePackagePublication(recipe, owner);
  mocks.installation.mockResolvedValue({
    root: recipe.maintenance.expected.installationRoot,
    manifestDigest: "d".repeat(64),
  });
  await expect(reconcileRecipePackagePublication(recipe, owner)).rejects.toThrow("unresolved");
  expect(mocks.receipts.get("core.package-publish")?.phase).toBe("outcome-unknown");
});
it("retains a committed maintenance result when current state contracts have drifted", async () => {
  await prepareRecipeTargetMaintenance(recipe, owner);
  mocks.maintenance.mockResolvedValue({ binding: recipe.maintenance.binding, phase: "committed" });
  mocks.state.mockResolvedValue([{ ...recipe.sourceStateVersions[0], userVersion: 2 }]);
  await expect(reconcileRecipeTargetMaintenance(recipe, owner)).rejects.toThrow("unresolved");
  expect(mocks.receipts.get("core.gateway-maintenance")?.phase).toBe("outcome-unknown");
});
it("does not equate a skipped restart or retained healthy ledger with native verification", async () => {
  await prepareRecipeServiceActivation(recipe, owner);
  await expect(reconcileRecipeServiceActivation(recipe, owner, false)).rejects.toThrow(
    "unresolved",
  );
  expect(mocks.receipts.get("core.service-verify")?.observation?.status).toBe("unavailable");
});
it("requires the real current service PID to match the native readiness verification", async () => {
  await prepareRecipeServiceActivation(recipe, owner);
  mocks.service.mockResolvedValue({
    env: owner.env,
    running: true,
    runtime: {
      status: "running",
      pid: 41,
      systemd: {
        scope: "user",
        unit: recipe.service.unitName,
        managerUid: recipe.service.managerUid,
      },
    },
  });
  await expect(reconcileRecipeServiceActivation(recipe, owner, true)).rejects.toThrow("unresolved");
  mocks.service.mockResolvedValue({
    env: owner.env,
    running: true,
    runtime: {
      status: "running",
      pid: 42,
      systemd: {
        scope: "user",
        unit: recipe.service.unitName,
        managerUid: recipe.service.managerUid,
      },
    },
  });
  await reconcileRecipeServiceActivation(recipe, owner, true);
  expect(mocks.receipts.get("core.service-verify")?.phase).toBe("verified");
  expect(owner.assertEffectsSettled).toHaveBeenCalled();
});

import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { UpdateRecoveryFence } from "../update-run-recovery.js";
import type { UpgradeRecipeMaintenanceReceipt } from "./maintenance-contract.js";
import type { UpgradeRecipeStepReceipt } from "./receipts-contract.js";
import type { OriginalUpgradeRecipeRun } from "./recovery-contract.js";
import {
  resumeUpgradeRecipeOriginalRun,
  type RetainedUpgradeRecipeRun,
  type UpgradeRecipeRecoveryPorts,
} from "./recovery.js";

const native = vi.hoisted(() => ({
  active: false,
  refused: false,
  authority: {
    installKey: "/installation",
    databasePath: "/control/leases.sqlite",
    databaseIdentity: "pinned-db",
    parentIdentity: "pinned-parent",
    owner: "original-owner",
  },
  acquired: vi.fn(),
  entered: vi.fn(),
}));
vi.mock("../../cli/update-cli/update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli/update-cli/update-command-executor.js")>()),
  captureUpdateCommandExecutorAuthority: () => native.authority,
  withUpdateCommandExecutor: async (
    runId: string,
    operation: (executor: {
      enter: (root: string) => Promise<UpdateRecoveryFence>;
    }) => Promise<unknown>,
    options: unknown,
  ) => {
    native.acquired(runId, options);
    native.active = true;
    try {
      return await operation({
        enter: async (root) => {
          native.entered(root);
          if (native.refused) {
            throw new Error("original child remains live");
          }
          return {
            assertCurrent: () => {
              if (!native.active) {
                throw new Error("native fence expired");
              }
            },
          };
        },
      });
    } finally {
      native.active = false;
    }
  },
}));

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const runId = "00000000-0000-4000-8000-000000000001";
  const artifactBytes = new Map<string, Buffer>([
    ["/control/plan", Buffer.from("exact approved plan")],
    ["/control/config", Buffer.from("exact approved config")],
    ["/control/authorization", Buffer.from("original durable admission")],
  ]);
  const artifact = (path: string) => {
    const bytes = artifactBytes.get(path)!;
    return { path, sha256: sha256(bytes), length: bytes.length };
  };
  const { owner: _owner, ...nativeAuthority } = native.authority;
  const retained: RetainedUpgradeRecipeRun = {
    schemaVersion: 1,
    originalNativeOwner: "original-owner",
    binding: {
      protocol: 1,
      runId,
      planDigest: "a".repeat(64),
      targetArtifactId: "target",
      installationKey: "/installation",
      stateRootKey: "/state",
    },
    nativeAuthority,
    ledgerAuthority: {
      databasePath: "/ledger/openclaw.sqlite",
      databaseIdentity: "1:2",
      parentIdentity: "1:3",
    },
    planArtifact: artifact("/control/plan"),
    configArtifact: artifact("/control/config"),
    authorizationArtifact: artifact("/control/authorization"),
    runner: {
      root: "/runner",
      manifestDigest: "b".repeat(64),
      closureDigest: "c".repeat(64),
      runtimePath: "/runner/node",
      entrypointPath: "/runner/main.mjs",
    },
    stepBindings: [
      {
        protocol: 1,
        runId,
        planDigest: "a".repeat(64),
        stepId: "stage",
        recipeId: "recipe",
        recipeRevision: 1,
        adapterId: "stage",
        adapterRevision: 1,
        adapterArtifactDigest: "d".repeat(64),
        phase: "prepare",
        resources: [
          {
            resourceKey: "private-package",
            identityDigest: "e".repeat(64),
            beforeDigest: "f".repeat(64),
            expectedAfterDigest: "0".repeat(64),
          },
        ],
      },
    ],
  };
  const envelope = Buffer.from(JSON.stringify(retained));
  const original: OriginalUpgradeRecipeRun = {
    runId,
    status: "running",
    phase: "validating",
    retainedEvidenceSha256: sha256(envelope),
  };
  const receipts: {
    maintenance: UpgradeRecipeMaintenanceReceipt | null;
    steps: UpgradeRecipeStepReceipt[];
  } = { maintenance: null, steps: [] };
  const ports: UpgradeRecipeRecoveryPorts = {
    readOriginalRun: vi.fn(async () => original),
    readRetainedEnvelope: vi.fn(async () => envelope),
    readArtifact: vi.fn(async (item) => artifactBytes.get(item.path)!),
    verifyRetainedAuthorization: vi.fn(async () => {}),
    verifyRetainedPlanAndConfig: vi.fn(async () => {}),
    verifyRetainedRunner: vi.fn(async () => ({
      ...retained.runner,
      purpose: "production" as const,
      runtimeArtifactId: "runtime",
      bootstrapArtifactId: "bootstrap",
      nativeDependencies: [],
    })),
    assertOriginalRecoveryOwner: vi.fn(async () => {}),
    readReceipts: vi.fn(async () => receipts),
  };
  const continueRun = vi.fn(
    async ({
      selection,
      fence,
    }: Parameters<Parameters<typeof resumeUpgradeRecipeOriginalRun>[0]["continueRun"]>[0]) => {
      fence.assertCurrent();
      return selection;
    },
  );
  return { runId, retained, original, artifactBytes, receipts, ports, continueRun };
}
beforeEach(() => {
  native.active = false;
  native.refused = false;
  native.authority = {
    installKey: "/installation",
    databasePath: "/control/leases.sqlite",
    databaseIdentity: "pinned-db",
    parentIdentity: "pinned-parent",
    owner: "original-owner",
  };
  vi.clearAllMocks();
});

it("reacquires the original pinned native store and passes a live scoped fence, never creating a run", async () => {
  const f = fixture();
  const result = await resumeUpgradeRecipeOriginalRun(f);
  expect(native.acquired).toHaveBeenCalledWith(f.runId, {
    existingAuthority: f.retained.nativeAuthority,
    originalRecipeOwner: { runId: f.runId, owner: f.retained.originalNativeOwner },
  });
  expect(native.entered).toHaveBeenCalledWith("/installation");
  expect(result).toMatchObject({
    phase: "resume-preparation",
    automaticSnapshotRestoreAllowed: false,
  });
  expect(f.ports.verifyRetainedAuthorization).toHaveBeenCalledTimes(2);
  expect(f.ports.verifyRetainedRunner).toHaveBeenCalledTimes(2);
  expect(f.ports.readOriginalRun).toHaveBeenCalledTimes(2);
  const fence = f.continueRun.mock.calls[0]![0].fence;
  expect(() => fence.assertCurrent()).toThrow("native fence expired");
});

it("refuses a different native owner even in the same pinned original control store", async () => {
  const f = fixture();
  native.authority.owner = "foreign-owner";
  await expect(resumeUpgradeRecipeOriginalRun(f)).rejects.toThrow("original pinned control store");
  expect(f.continueRun).not.toHaveBeenCalled();
});

it("corrupted immutable plan/config evidence never reaches native acquisition or continuation", async () => {
  const f = fixture();
  f.artifactBytes.set("/control/config", Buffer.from("changed configuration"));
  await expect(resumeUpgradeRecipeOriginalRun(f)).rejects.toThrow(/artifact verification failed/);
  expect(native.acquired).not.toHaveBeenCalled();
  expect(f.continueRun).not.toHaveBeenCalled();
});

it("refuses foreign retained journals and a still-running original executor", async () => {
  const f = fixture();
  vi.mocked(f.ports.assertOriginalRecoveryOwner).mockRejectedValueOnce(
    new Error("legacy recovery owner"),
  );
  await expect(resumeUpgradeRecipeOriginalRun(f)).rejects.toThrow("legacy recovery owner");
  expect(native.acquired).not.toHaveBeenCalled();
  native.refused = true;
  await expect(resumeUpgradeRecipeOriginalRun(f)).rejects.toThrow("original child remains live");
  expect(f.continueRun).not.toHaveBeenCalled();
});

it("COMMIT_INTENT and committed phases preserve newer state and select only reconciliation/current verification", async () => {
  const f = fixture();
  f.receipts.steps = [
    {
      binding: f.retained.stepBindings[0]!,
      phase: "intent",
      revision: 1,
      intentAtMs: 1,
      updatedAtMs: 1,
    },
  ];
  f.receipts.maintenance = {
    binding: f.retained.binding,
    phase: "commit-intent",
    revision: 2,
    updatedAtMs: 2,
  };
  expect(await resumeUpgradeRecipeOriginalRun(f)).toMatchObject({
    phase: "reconcile-post-admission",
    externalWorkPossible: true,
    automaticSnapshotRestoreAllowed: false,
    pendingStepIds: ["stage"],
  });
  f.receipts.maintenance.phase = "committed";
  f.receipts.maintenance.revision = 3;
  expect(await resumeUpgradeRecipeOriginalRun(f)).toMatchObject({
    phase: "verify-committed-current-state",
    externalWorkPossible: true,
    automaticSnapshotRestoreAllowed: false,
  });
});

it("changed original run evidence or native database identity after acquisition refuses effects", async () => {
  const f = fixture();
  vi.mocked(f.ports.readOriginalRun)
    .mockResolvedValueOnce(f.original)
    .mockResolvedValueOnce({ ...f.original, retainedEvidenceSha256: "1".repeat(64) });
  await expect(resumeUpgradeRecipeOriginalRun(f)).rejects.toThrow("run changed");
  expect(f.continueRun).not.toHaveBeenCalled();
  const other = fixture();
  native.authority.databaseIdentity = "replacement-db";
  await expect(resumeUpgradeRecipeOriginalRun(other)).rejects.toThrow(
    "original pinned control store",
  );
  expect(other.continueRun).not.toHaveBeenCalled();
});

it("cannot regress a previously observed external-work boundary while reacquiring authority", async () => {
  const f = fixture();
  const before = {
    maintenance: {
      binding: f.retained.binding,
      phase: "commit-intent" as const,
      revision: 2,
      updatedAtMs: 2,
    },
    steps: [],
  };
  vi.mocked(f.ports.readReceipts)
    .mockResolvedValueOnce(before)
    .mockResolvedValueOnce({ maintenance: null, steps: [] });
  await expect(resumeUpgradeRecipeOriginalRun(f)).rejects.toThrow(/regressed or disappeared/);
  expect(f.continueRun).not.toHaveBeenCalled();
});

it("missing maintenance after activation or a terminal run is not permission to restart preparation", async () => {
  const f = fixture();
  f.original.phase = "activating";
  await expect(resumeUpgradeRecipeOriginalRun(f)).rejects.toThrow("external work may be possible");
  expect(native.acquired).not.toHaveBeenCalled();
  f.original.status = "failed";
  await expect(resumeUpgradeRecipeOriginalRun(f)).rejects.toThrow("original running update");
  expect(f.continueRun).not.toHaveBeenCalled();
});

it.each([
  ["staging", "requested"],
  ["validating", "staging"],
  ["repairing", "validating"],
  ["activating", "repairing"],
  ["restarting", "activating"],
  ["verifying", "restarting"],
  ["finished", "verifying"],
] as const)(
  "refuses original ledger phase regression from %s to %s at native readmission",
  async (before, after) => {
    const f = fixture();
    f.original.phase = before;
    f.receipts.maintenance = {
      binding: f.retained.binding,
      phase: "maintenance-required",
      revision: 1,
      updatedAtMs: 1,
    };
    vi.mocked(f.ports.readOriginalRun)
      .mockResolvedValueOnce({ ...f.original })
      .mockResolvedValueOnce({ ...f.original, phase: after });
    await expect(resumeUpgradeRecipeOriginalRun(f)).rejects.toThrow(
      "run changed during native admission",
    );
    expect(native.acquired).toHaveBeenCalledOnce();
    expect(f.continueRun).not.toHaveBeenCalled();
  },
);

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stableConfigStringify } from "../../config/runtime-config-snapshot-match.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  retainedUpgradeRecipeRunSchema,
  type UpgradeRecipeRecoveryPorts,
} from "../../infra/upgrade-recipes/recovery.js";
import type { VerifiedUpgradeRecipeRunnerBundle } from "../../infra/upgrade-recipes/runner-bundle-contract.js";
import { createRecipeOriginalRecoveryPorts } from "./recipe-recovery-ports.js";
import { recipeUpdateApprovalFacts, recipeUpdateContextSchema } from "./update-recipe-context.js";
import { approvedContext } from "./update-recipe-context.test-support.js";

const seams = vi.hoisted(() => ({
  readEnvelope: vi.fn(),
  readArtifact: vi.fn(),
  authenticate: vi.fn(),
  verifyBundle: vi.fn(),
  verifyInstallation: vi.fn(),
  assertCurrent: vi.fn(),
}));

// mock-isolation: retain real port admission while keeping operator databases outside the fixture.
vi.mock("../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({
    admission: { assertCurrent: seams.assertCurrent },
  }),
}));
// mock-isolation: supply immutable ledger artifacts without opening a live database or writer.
vi.mock("../../infra/upgrade-recipes/retained-run.js", () => ({
  createRetainedUpgradeRecipeRunStore: () => ({
    readRetainedEnvelope: seams.readEnvelope,
    readArtifact: seams.readArtifact,
    recoveryPorts: (
      verifiers: Omit<
        UpgradeRecipeRecoveryPorts,
        "readOriginalRun" | "readRetainedEnvelope" | "readArtifact"
      >,
    ) => ({
      ...verifiers,
      readOriginalRun: vi.fn(),
      readRetainedEnvelope: seams.readEnvelope,
      readArtifact: seams.readArtifact,
    }),
  }),
}));
// mock-isolation: supply an authenticated bundle without reading or executing operator artifacts.
vi.mock("../../infra/upgrade-recipes/runner-bundle.js", () => ({
  verifyUpgradeRecipeRunnerBundle: seams.verifyBundle,
}));
vi.mock("./update-recipe-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-recipe-context.js")>()),
  resolveAuthenticatedRecipeUpdateCatalog: seams.authenticate,
  verifyRecipeUpdateInstallation: seams.verifyInstallation,
}));

const productionEntry = "/runner/entry.mjs";
const releaseEntry = "/runner/release-qualification-entry.mjs";

beforeEach(() => {
  vi.spyOn(fs, "realpath").mockImplementation(async (filename) => String(filename));
  seams.authenticate.mockResolvedValue({});
  seams.verifyInstallation.mockResolvedValue({});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function fixture(
  releaseQualification: boolean,
  targetReceiver = false,
  missingEntry = false,
) {
  let recipe = approvedContext();
  recipe.maintenance.binding.runId = "00000000-0000-4000-8000-000000000001";
  recipe.maintenance.expected.runtimeExecutable = process.execPath;
  if (releaseQualification) {
    recipe.releaseQualification = {
      purpose: "release-qualification",
      recipe: recipe.route.recipe,
      machineId: "a".repeat(32),
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      mountNamespace: "mnt:[1]",
      pidNamespace: "pid:[1]",
    };
    delete recipe.route.qualificationId;
  }
  // Regenerate consent through the canonical fact/digest owners after changing fixture facts.
  const { approvedPlan: _approvedPlan, approvedPlanDigest: _approvedDigest, ...facts } = recipe;
  const { digest: _planDigest, ...originalPlan } = recipe.approvedPlan;
  const plan = { ...originalPlan, facts: recipeUpdateApprovalFacts(facts) };
  const digest = createHash("sha256").update(stableConfigStringify(plan)).digest("hex");
  recipe = recipeUpdateContextSchema.parse({
    ...recipe,
    approvedPlan: { ...plan, digest },
    approvedPlanDigest: digest,
    maintenance: {
      ...recipe.maintenance,
      binding: { ...recipe.maintenance.binding, planDigest: digest },
    },
  });
  const ledgerPath = path.join(recipe.maintenance.expected.stateRoot, "state", "openclaw.sqlite");
  const bundle: VerifiedUpgradeRecipeRunnerBundle = {
    root: recipe.runner.root,
    purpose: "production",
    manifestDigest: recipe.runner.manifestDigest,
    closureDigest: recipe.runner.closureDigest,
    runtimePath: process.execPath,
    entrypointPath: productionEntry,
    ...(!missingEntry ? { releaseQualificationEntrypointPath: releaseEntry } : {}),
    runtimeArtifactId: "runtime",
    bootstrapArtifactId: "bootstrap",
    nativeDependencies: [],
  };
  const artifact = { path: "/control/artifact", sha256: "a".repeat(64), length: 1 };
  const retained = retainedUpgradeRecipeRunSchema.parse({
    schemaVersion: 1,
    binding: recipe.maintenance.binding,
    originalNativeOwner: "original-owner",
    nativeAuthority: {
      installKey: recipe.maintenance.binding.installationKey,
      databasePath: "/control/native.sqlite",
      databaseIdentity: "1:2",
      parentIdentity: "1:3",
    },
    ledgerAuthority: { databasePath: ledgerPath, databaseIdentity: "1:4", parentIdentity: "1:5" },
    planArtifact: artifact,
    configArtifact: artifact,
    authorizationArtifact: artifact,
    runner: {
      root: bundle.root,
      manifestDigest: bundle.manifestDigest,
      closureDigest: bundle.closureDigest,
      runtimePath: bundle.runtimePath,
      entrypointPath: releaseQualification ? releaseEntry : productionEntry,
    },
    stepBindings: [],
  });
  seams.readEnvelope.mockResolvedValue(Buffer.from(JSON.stringify(retained)));
  seams.readArtifact.mockResolvedValue(Buffer.from(JSON.stringify(recipe)));
  seams.verifyBundle.mockResolvedValue(bundle);
  const actualEntry = targetReceiver
    ? path.join(
        recipe.maintenance.expected.installationRoot,
        "dist",
        runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
      )
    : releaseQualification
      ? releaseEntry
      : productionEntry;
  const recovery = await createRecipeOriginalRecoveryPorts({
    runId: retained.binding.runId,
    ledgerPath,
    runnerEntryUrl: pathToFileURL(actualEntry).href,
    ...(targetReceiver ? { targetReceiver: true as const } : {}),
  });
  return { recovery, retained, bundle, actualEntry };
}

describe("original recovery runner entry custody", () => {
  it("preserves the authenticated production runner entry", async () => {
    const { recovery, retained } = await fixture(false);
    const admitted = await recovery.ports.verifyRetainedRunner(retained);
    expect(admitted.entrypointPath).toBe(retained.runner.entrypointPath);
    expect(admitted.entrypointPath).toBe(productionEntry);
    expect(seams.verifyInstallation).not.toHaveBeenCalled();
  });

  it("returns the retained release entry without mutating the production bundle", async () => {
    const { recovery, retained, bundle } = await fixture(true);
    const admitted = await recovery.ports.verifyRetainedRunner(retained);
    expect(admitted.entrypointPath).toBe(retained.runner.entrypointPath);
    expect(admitted.entrypointPath).toBe(releaseEntry);
    expect(bundle.entrypointPath).toBe(productionEntry);
    expect(admitted).not.toBe(bundle);
  });

  it("admits the actual target receiver but retains the original release runner entry", async () => {
    const { recovery, retained, bundle, actualEntry } = await fixture(true, true);
    const admitted = await recovery.ports.verifyRetainedRunner(retained);
    expect(admitted.entrypointPath).toBe(retained.runner.entrypointPath);
    expect(admitted.entrypointPath).not.toBe(actualEntry);
    expect(bundle.entrypointPath).toBe(productionEntry);
    expect(seams.verifyInstallation).toHaveBeenCalledWith(
      recovery.recipe,
      recovery.recipe.maintenance.expected.installationRoot,
      "target",
    );
  });

  it("refuses release recovery when the authenticated bundle lacks its retained entry", async () => {
    const { recovery, retained } = await fixture(true, true, true);
    await expect(recovery.ports.verifyRetainedRunner(retained)).rejects.toThrow();
    expect(seams.verifyInstallation).not.toHaveBeenCalled();
  });
});

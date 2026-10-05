import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import type { AuthenticatedUpgradeRecipeCatalog } from "../../infra/upgrade-recipes/catalog.js";
import {
  assertReleaseQualificationCustody,
  bindReleaseQualificationTargetReceiver,
} from "./recipe-first-qualification.js";
import { releaseQualificationBindingSchema } from "./recipe-release-qualification-contract.js";
import { approvedContext } from "./update-recipe-context.test-support.js";

const bundle = vi.hoisted(() => ({ verify: vi.fn(), installation: vi.fn(), authority: vi.fn() }));
// mock-isolation: custody transitions must not open or authenticate the operator installation.
vi.mock("../../infra/upgrade-recipes/installation-identity.js", () => ({
  verifyAuthenticatedUpgradeInstallation: bundle.installation,
}));
// mock-isolation: exercise revocation and admission without acquiring a live native update lease.
vi.mock("./update-command-executor.js", () => ({
  captureUpdateCommandExecutorAuthority: bundle.authority,
}));
const originalArgv = [...process.argv];
afterEach(() => {
  process.argv = [...originalArgv];
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
// mock-isolation: supply authenticated-closure outcomes without reading operator runner roots.
vi.mock("../../infra/upgrade-recipes/runner-bundle.js", () => ({
  verifyUpgradeRecipeRunnerBundle: bundle.verify,
}));

describe("first qualification custody", () => {
  it("refuses a forged serialized release purpose in an authenticated production runner before observing machine state", async () => {
    const recipe = approvedContext();
    recipe.releaseQualification = releaseQualificationBindingSchema.parse({
      purpose: "release-qualification",
      recipe: recipe.route.recipe,
      machineId: "a".repeat(32),
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      mountNamespace: "mnt:[1]",
      pidNamespace: "pid:[1]",
    });
    bundle.verify.mockResolvedValueOnce({ purpose: "production" });
    await expect(
      assertReleaseQualificationCustody(recipe, {} as AuthenticatedUpgradeRecipeCatalog),
    ).rejects.toThrow("authenticated release-only entry in the production runner");
  });
  it("refuses an old/default runner manifest as release authority", async () => {
    const recipe = approvedContext();
    recipe.releaseQualification = {
      purpose: "release-qualification",
      recipe: recipe.route.recipe,
      machineId: "a".repeat(32),
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      mountNamespace: "mnt:[1]",
      pidNamespace: "pid:[1]",
    };
    bundle.verify.mockResolvedValueOnce({});
    await expect(
      assertReleaseQualificationCustody(recipe, {} as AuthenticatedUpgradeRecipeCatalog),
    ).rejects.toThrow("authenticated release-only entry in the production runner");
  });
  function receiverFixture(initCgroup = "0::/") {
    const recipe = approvedContext();
    recipe.releaseQualification = {
      purpose: "release-qualification",
      recipe: recipe.route.recipe,
      machineId: "a".repeat(32),
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      mountNamespace: "mnt:[1]",
      pidNamespace: "pid:[1]",
    };
    recipe.catalog.controlRoot = "/qualification/control";
    recipe.catalog.metadataDir = "/qualification/metadata";
    recipe.runner.root = "/qualification/runner";
    recipe.artifactsDirectory = "/qualification/artifacts";
    recipe.localArchivePath = "/qualification/artifacts/target.tgz";
    Object.assign(recipe.maintenance.expected, {
      installationRoot: "/qualification/installation",
      stateRoot: "/qualification/state",
      configPath: "/qualification/state/config.json",
      runtimeExecutable: process.execPath,
    });
    recipe.maintenance.binding.installationKey = recipe.maintenance.expected.installationRoot;
    const entry = path.join(
      recipe.maintenance.expected.installationRoot,
      "dist",
      runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
    );
    process.argv[1] = entry;
    vi.spyOn(fs, "realpath").mockImplementation(async (value) => String(value));
    const observations: Record<string, string> = {
      "/etc/machine-id": recipe.releaseQualification.machineId,
      "/proc/sys/kernel/random/boot_id": recipe.releaseQualification.bootId,
      "/proc/1/comm": "systemd",
      "/run/systemd/container": "docker",
      "/proc/self/mountinfo": "1 0 0:1 / / rw - overlay overlay rw",
      "/proc/1/cgroup": initCgroup,
    };
    vi.spyOn(fs, "readFile").mockImplementation(async (value) => {
      if (typeof value !== "string" || !(value in observations)) {
        throw new Error("Unexpected machine observation path");
      }
      return observations[value] as never;
    });
    vi.spyOn(fs, "readlink").mockImplementation(async (value) =>
      String(value).endsWith("mnt") ? "mnt:[1]" : "pid:[1]",
    );
    bundle.verify.mockResolvedValue({
      purpose: "production",
      runtimePath: process.execPath,
      releaseQualificationEntrypointPath: "/qualification/runner/release-qualification-entry.mjs",
    });
    bundle.authority.mockReturnValue({ installKey: recipe.maintenance.binding.installationKey });
    bundle.installation.mockResolvedValue({});
    const catalog = {
      catalog: {
        recipes: [
          {
            ...recipe.route.recipe,
            purpose: "production",
            qualificationIds: ["new-proof"],
            source: { releaseIds: [recipe.sourceReleaseId] },
            targetReleaseIds: [recipe.targetReleaseId],
          },
        ],
        qualificationIntents: [
          {
            recipe: recipe.route.recipe,
            runnerManifestArtifactId: recipe.runner.manifestArtifactId,
            sourceReleaseId: recipe.sourceReleaseId,
            targetReleaseId: recipe.targetReleaseId,
            qualificationId: "new-proof",
          },
        ],
      },
    } as unknown as AuthenticatedUpgradeRecipeCatalog;
    const fence = { assertCurrent: vi.fn() };
    return { recipe, catalog, fence, entryUrl: pathToFileURL(entry).href };
  }

  it("admits the target only after native original-run binding and actual target authentication", async () => {
    const { recipe, catalog, fence, entryUrl } = receiverFixture();
    await expect(assertReleaseQualificationCustody(recipe, catalog)).rejects.toThrow(
      "authenticated release-only entry",
    );
    expect(bundle.installation).not.toHaveBeenCalled();
    bindReleaseQualificationTargetReceiver(recipe, fence, entryUrl);
    await assertReleaseQualificationCustody(recipe, catalog);
    expect(bundle.authority).toHaveBeenCalledWith(fence, recipe.maintenance.binding.runId);
    expect(bundle.installation).toHaveBeenCalledWith({
      catalog,
      root: recipe.maintenance.expected.installationRoot,
      releaseId: recipe.targetReleaseId,
      artifactsDirectory: recipe.artifactsDirectory,
      forbiddenRoots: recipe.catalog.forbiddenRoots,
    });
    expect(fence.assertCurrent).toHaveBeenCalled();
  });

  it.each(["0::/", "0::/init.scope"])(
    "admits the original signed release-only entry in private cgroup %s without transferring target authority",
    async (initCgroup) => {
      const { recipe, catalog } = receiverFixture(initCgroup);
      process.argv[1] = "/qualification/runner/release-qualification-entry.mjs";
      await assertReleaseQualificationCustody(recipe, catalog);
      expect(bundle.installation).not.toHaveBeenCalled();
      expect(bundle.authority).not.toHaveBeenCalled();
    },
  );

  it.each(["0::/system.slice/docker-example.scope/init.scope", "0::/other.scope"])(
    "refuses a release-only entry outside the private systemd root: %s",
    async (initCgroup) => {
      const { recipe, catalog } = receiverFixture(initCgroup);
      process.argv[1] = "/qualification/runner/release-qualification-entry.mjs";
      await expect(assertReleaseQualificationCustody(recipe, catalog)).rejects.toThrow(
        "private cgroup root",
      );
    },
  );

  it("refuses a target caller presenting a different worker entry URL", async () => {
    const { recipe, catalog, fence } = receiverFixture();
    bindReleaseQualificationTargetReceiver(recipe, fence, "file:///qualification/other-worker.mjs");
    await expect(assertReleaseQualificationCustody(recipe, catalog)).rejects.toThrow(
      "authenticated release-only entry",
    );
    expect(bundle.installation).not.toHaveBeenCalled();
  });

  it("cannot transfer target admission to cloned caller selectors", async () => {
    const { recipe, catalog, fence, entryUrl } = receiverFixture();
    bindReleaseQualificationTargetReceiver(recipe, fence, entryUrl);
    await expect(
      assertReleaseQualificationCustody(structuredClone(recipe), catalog),
    ).rejects.toThrow("authenticated release-only entry");
  });

  it("rejects a target without original signed intent, before authenticating target installation", async () => {
    const { recipe, catalog, fence, entryUrl } = receiverFixture();
    bindReleaseQualificationTargetReceiver(recipe, fence, entryUrl);
    catalog.catalog.qualificationIntents = [];
    await expect(assertReleaseQualificationCustody(recipe, catalog)).rejects.toThrow(
      "authenticated provisional release intent",
    );
    expect(bundle.installation).not.toHaveBeenCalled();
  });

  it("rejects an unverified actual target and revoked native owner", async () => {
    const { recipe, catalog, fence, entryUrl } = receiverFixture();
    bindReleaseQualificationTargetReceiver(recipe, fence, entryUrl);
    bundle.installation.mockRejectedValueOnce(new Error("target bytes differ"));
    await expect(assertReleaseQualificationCustody(recipe, catalog)).rejects.toThrow(
      "target bytes differ",
    );
    fence.assertCurrent.mockImplementation(() => {
      throw new Error("executor expired");
    });
    await expect(assertReleaseQualificationCustody(recipe, catalog)).rejects.toThrow(
      "executor expired",
    );
  });

  it("rejects mismatched native installation ownership at admission", () => {
    const { recipe, fence, entryUrl } = receiverFixture();
    bundle.authority.mockReturnValue({ installKey: "/other-installation" });
    expect(() => bindReleaseQualificationTargetReceiver(recipe, fence, entryUrl)).toThrow(
      "original native installation executor",
    );
  });
});

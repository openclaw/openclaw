import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { AuthenticatedUpgradeRecipeCatalog } from "../../infra/upgrade-recipes/catalog.js";
import { verifyAuthenticatedUpgradeInstallation } from "../../infra/upgrade-recipes/installation-identity.js";
import { verifyUpgradeRecipeRunnerBundle } from "../../infra/upgrade-recipes/runner-bundle.js";
import {
  releaseQualificationBindingSchema,
  type ReleaseQualificationBinding,
} from "./recipe-release-qualification-contract.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";

type Selectors = {
  releaseQualification?: ReleaseQualificationBinding;
  catalog: { forbiddenRoots: string[]; controlRoot: string; metadataDir: string };
  runner: { root: string; manifestArtifactId: string };
  sourceReleaseId: string;
  targetReleaseId: string;
  artifactsDirectory: string;
  localArchivePath: string;
  maintenance: {
    expected: {
      installationRoot: string;
      stateRoot: string;
      configPath: string;
      runtimeExecutable: string;
    };
  };
};

const targetReceivers = new WeakMap<object, { fence: UpdateRecoveryFence; entryUrl: string }>();

/** Register only a live native executor for this exact retained original run, never a serialized flag. */
export function bindReleaseQualificationTargetReceiver(
  selectors: Selectors & {
    maintenance: Selectors["maintenance"] & {
      binding: { runId: string; installationKey: string };
    };
  },
  fence: UpdateRecoveryFence,
  entryUrl: string,
): void {
  const { runId, installationKey } = selectors.maintenance.binding;
  const authority = captureUpdateCommandExecutorAuthority(fence, runId);
  if (
    authority.installKey !== installationKey ||
    installationKey !== selectors.maintenance.expected.installationRoot
  ) {
    throw new Error(
      "Release qualification receiver lost its original native installation executor.",
    );
  }
  fence.assertCurrent();
  const prior = targetReceivers.get(selectors);
  if (prior && (prior.fence !== fence || prior.entryUrl !== entryUrl)) {
    throw new Error("Release qualification cannot replace its admitted target receiver.");
  }
  targetReceivers.set(selectors, { fence, entryUrl });
}

/** Only a TUF-authenticated release-purpose runner in the same disposable native machine admits this purpose. */
export async function assertReleaseQualificationCustody(
  selectors: Selectors,
  catalog: AuthenticatedUpgradeRecipeCatalog,
): Promise<void> {
  const binding = releaseQualificationBindingSchema.parse(selectors.releaseQualification);
  const runner = await verifyUpgradeRecipeRunnerBundle({
    catalog,
    bundleRoot: selectors.runner.root,
    manifestArtifactId: selectors.runner.manifestArtifactId,
    forbiddenRoots: selectors.catalog.forbiddenRoots,
  });
  const receiver = targetReceivers.get(selectors);
  receiver?.fence.assertCurrent();
  const actualEntry = process.argv[1] ? await fs.realpath(process.argv[1]) : undefined;
  const receiverEntry = path.join(
    selectors.maintenance.expected.installationRoot,
    "dist",
    runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
  );
  const admittedEntry = receiver
    ? actualEntry === receiverEntry &&
      (await fs.realpath(fileURLToPath(receiver.entryUrl))) === receiverEntry
    : actualEntry === runner.releaseQualificationEntrypointPath;
  if (
    runner.purpose !== "production" ||
    !runner.releaseQualificationEntrypointPath ||
    !admittedEntry ||
    (await fs.realpath(process.execPath)) !== runner.runtimePath ||
    selectors.maintenance.expected.runtimeExecutable !== runner.runtimePath
  ) {
    throw new Error(
      "First qualification requires its authenticated release-only entry in the production runner; a production runner cannot admit this purpose.",
    );
  }
  const route = catalog.catalog.recipes.find(
    (entry) => entry.id === binding.recipe.id && entry.revision === binding.recipe.revision,
  );
  const intent = catalog.catalog.qualificationIntents?.find(
    (entry) =>
      entry.recipe.id === binding.recipe.id &&
      entry.recipe.revision === binding.recipe.revision &&
      entry.runnerManifestArtifactId === selectors.runner.manifestArtifactId &&
      entry.sourceReleaseId === selectors.sourceReleaseId &&
      entry.targetReleaseId === selectors.targetReleaseId &&
      route?.qualificationIds.includes(entry.qualificationId),
  );
  if (
    !route ||
    route.purpose !== "production" ||
    !intent ||
    !route.source.releaseIds.includes(intent.sourceReleaseId) ||
    !route.targetReleaseIds.includes(intent.targetReleaseId)
  ) {
    throw new Error(
      "First qualification requires authenticated provisional release intent, not a qualification claim.",
    );
  }
  if (receiver) {
    // Verify the actual installed target closure with the original authenticated catalog,
    // without recursively entering the context's custody resolver.
    await verifyAuthenticatedUpgradeInstallation({
      catalog,
      root: selectors.maintenance.expected.installationRoot,
      releaseId: selectors.targetReleaseId,
      artifactsDirectory: selectors.artifactsDirectory,
      forbiddenRoots: selectors.catalog.forbiddenRoots,
    });
    receiver.fence.assertCurrent();
  }
  const observations = await Promise.all([
    fs.readFile("/etc/machine-id", "utf8"),
    fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    fs.readlink("/proc/self/ns/mnt"),
    fs.readlink("/proc/self/ns/pid"),
    fs.readFile("/proc/1/comm", "utf8"),
    fs.readFile("/run/systemd/container", "utf8"),
    fs.readFile("/proc/self/mountinfo", "utf8"),
    fs.readFile("/proc/1/cgroup", "utf8"),
  ]);
  if (
    observations[0].trim() !== binding.machineId ||
    observations[1].trim() !== binding.bootId ||
    observations[2] !== binding.mountNamespace ||
    observations[3] !== binding.pidNamespace ||
    observations[4].trim() !== "systemd" ||
    observations[5].trim() !== "docker" ||
    !observations[6]
      .split("\n")
      .some((line) => line.includes(" / / ") && line.includes(" - overlay ")) ||
    // PID 1 may enter systemd's init.scope within the private cgroup-v2 root.
    !observations[7].split("\n").some((line) => /^0::\/(?:init\.scope)?$/.test(line))
  ) {
    throw new Error(
      "First qualification lost its original isolated native systemd machine, boot, namespaces, or private cgroup root.",
    );
  }
  for (const selected of [
    selectors.catalog.controlRoot,
    selectors.catalog.metadataDir,
    selectors.runner.root,
    selectors.artifactsDirectory,
    selectors.localArchivePath,
    selectors.maintenance.expected.installationRoot,
    selectors.maintenance.expected.stateRoot,
    selectors.maintenance.expected.configPath,
  ]) {
    if (
      !selected.startsWith("/qualification/") ||
      path.resolve(selected) !== selected ||
      (await fs.realpath(selected)) !== selected
    ) {
      throw new Error(
        "First qualification cannot adopt host paths or a noncanonical disposable-machine owner.",
      );
    }
  }
  receiver?.fence.assertCurrent();
}

/** Capture the machine identity only; admission still requires the authenticated release runner. */
export async function observeReleaseQualificationBinding(
  recipe: ReleaseQualificationBinding["recipe"],
): Promise<ReleaseQualificationBinding> {
  const [machineId, bootId, mountNamespace, pidNamespace] = await Promise.all([
    fs.readFile("/etc/machine-id", "utf8"),
    fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    fs.readlink("/proc/self/ns/mnt"),
    fs.readlink("/proc/self/ns/pid"),
  ]);
  return releaseQualificationBindingSchema.parse({
    purpose: "release-qualification",
    recipe,
    machineId: machineId.trim(),
    bootId: bootId.trim(),
    mountNamespace,
    pidNamespace,
  });
}

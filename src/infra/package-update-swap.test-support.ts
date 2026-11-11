import fs from "node:fs/promises";
import path from "node:path";
import {
  createNpmTarget,
  createPnpmTarget,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { prepareNativePackageStage } from "./update-native-package-stage.js";

export async function createPackageSwapFixture(base: string) {
  const prefix = path.join(base, "live");
  const globalRoot = path.join(prefix, "lib", "node_modules");
  const packageRoot = path.join(globalRoot, "openclaw");
  const stagePrefix = path.join(base, "stage");
  const stageGlobalRoot = path.join(stagePrefix, "lib", "node_modules");
  const stagePackageRoot = path.join(stageGlobalRoot, "openclaw");
  await writePackageRoot(packageRoot, "1.0.0");
  await writePackageRoot(stagePackageRoot, "2.0.0");
  const launcher = path.join(prefix, "bin", "openclaw");
  const stagedLauncher = path.join(stagePrefix, "bin", "openclaw");
  for (const entry of [launcher, stagedLauncher]) {
    await fs.mkdir(path.dirname(entry), { recursive: true });
  }
  await fs.writeFile(launcher, "old launcher\n");
  await fs.writeFile(stagedLauncher, "candidate launcher\n");
  const params = {
    installTarget: createNpmTarget(globalRoot),
    packageName: "openclaw",
    stage: {
      prefix: stagePrefix,
      layout: {
        prefix: stagePrefix,
        globalRoot: stageGlobalRoot,
        binDir: path.dirname(stagedLauncher),
      },
      packageRoot: stagePackageRoot,
      installTarget: createNpmTarget(stageGlobalRoot),
    },
  };
  return { params, packageRoot, globalRoot, launcher };
}

export async function createNativePackageSwapFixture(base: string) {
  const project = path.join(base, "global");
  const globalRoot = path.join(project, "v11");
  const packageRoot = path.join(globalRoot, "group", "node_modules", "openclaw");
  const binDir = path.join(base, "bin");
  await writePackageRoot(packageRoot, "1.0.0");
  await fs.mkdir(binDir);
  const installTarget = createPnpmTarget(globalRoot, packageRoot);
  const native = await prepareNativePackageStage({
    installTarget,
    packageName: "openclaw",
    installSpec: "openclaw@2.0.0",
    globalBinDir: binDir,
    env: {},
  });
  if (!native) {
    throw new Error("missing native stage");
  }
  const candidate = path.join(native.projectRoot, path.relative(project, packageRoot));
  await writePackageRoot(candidate, "2.0.0");
  const params = {
    installTarget,
    packageName: "openclaw",
    stage: {
      prefix: native.projectRoot,
      layout: { prefix: native.projectRoot, globalRoot: native.globalRoot, binDir: native.binDir },
      packageRoot: candidate,
      installTarget: createPnpmTarget(native.globalRoot, candidate),
      native,
    },
  };
  return { params, native, packageRoot, candidate, binDir };
}

export async function createRetainedPackageSwap(
  base: string,
  prepare?: (fixture: Awaited<ReturnType<typeof createPackageSwapFixture>>) => Promise<void>,
) {
  const fixture = await createPackageSwapFixture(base);
  await prepare?.(fixture);
  let transaction: PackageUpdateTransaction | undefined;
  const result = await swapStagedPackageInstall({
    ...fixture.params,
    onTransaction: (retained) => {
      transaction = retained;
    },
  });
  if (!transaction || result.status !== "committed") {
    throw new Error(`Retained swap fixture failed: ${result.step.stderrTail}`);
  }
  return { ...fixture, result, transaction };
}

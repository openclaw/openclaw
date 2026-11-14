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

/** Paths and swap parameters of the npm fixture rooted at `base`; touches no files. */
export function resolvePackageSwapFixture(base: string) {
  const prefix = path.join(base, "live");
  const globalRoot = path.join(prefix, "lib", "node_modules");
  const packageRoot = path.join(globalRoot, "openclaw");
  const stagePrefix = path.join(base, "stage");
  const stageGlobalRoot = path.join(stagePrefix, "lib", "node_modules");
  const stagePackageRoot = path.join(stageGlobalRoot, "openclaw");
  const launcher = path.join(prefix, "bin", "openclaw");
  const params = {
    installTarget: createNpmTarget(globalRoot),
    packageName: "openclaw",
    stage: {
      prefix: stagePrefix,
      layout: {
        prefix: stagePrefix,
        globalRoot: stageGlobalRoot,
        binDir: path.join(stagePrefix, "bin"),
      },
      packageRoot: stagePackageRoot,
      installTarget: createNpmTarget(stageGlobalRoot),
    },
  };
  return { params, packageRoot, globalRoot, launcher };
}

export async function createPackageSwapFixture(base: string) {
  const fixture = resolvePackageSwapFixture(base);
  await writePackageRoot(fixture.packageRoot, "1.0.0");
  await writePackageRoot(fixture.params.stage.packageRoot, "2.0.0");
  const stagedLauncher = path.join(fixture.params.stage.layout.binDir, "openclaw");
  for (const entry of [fixture.launcher, stagedLauncher]) {
    await fs.mkdir(path.dirname(entry), { recursive: true });
  }
  await fs.writeFile(fixture.launcher, "old launcher\n");
  await fs.writeFile(stagedLauncher, "candidate launcher\n");
  return fixture;
}

export const symlinkDirectory = (target: string, link: string) =>
  fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");

export async function createLinkedPackageSwapFixture(rootDir: string, relative = false) {
  const fixture = await createPackageSwapFixture(rootDir);
  const checkout = path.join(rootDir, "checkout");
  await fs.rename(fixture.packageRoot, checkout);
  await fs.writeFile(path.join(checkout, "operator.txt"), "operator-owned checkout\n");
  // A linked checkout can reference dependencies outside the package root.
  await symlinkDirectory(rootDir, path.join(checkout, "external"));
  await symlinkDirectory(
    relative ? path.relative(path.dirname(fixture.packageRoot), checkout) : checkout,
    fixture.packageRoot,
  );
  return {
    ...fixture,
    checkout,
    target: await fs.readlink(fixture.packageRoot),
    linkIdentity: (await fs.lstat(fixture.packageRoot)).ino,
    checkoutIdentity: (await fs.stat(checkout)).ino,
  };
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

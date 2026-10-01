import path from "node:path";
import type { StagedPackageSwapParams } from "./package-update-swap-contract.js";
import { createFreeBsdPkgOwnershipInspection } from "./update-freebsd-pkg-ownership.js";
import { resolveNpmGlobalPrefixLayoutFromGlobalRoot } from "./update-npm-prefix.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";

export async function assertSwapTargetUnowned(
  root: string,
  launchers: readonly { destination: string }[],
  timeoutMs?: number,
): Promise<void> {
  // A fresh observation, not an atomic lock against an external pkg writer.
  const inspection = createFreeBsdPkgOwnershipInspection(timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS);
  await inspection.assertUnowned(root);
  for (const launcher of launchers) {
    await inspection.assertEntryUnowned(launcher.destination);
  }
}

export function resolveStagedPackageSwapTarget(params: StagedPackageSwapParams) {
  const native = params.stage.native;
  const targetLayout = native
    ? {
        prefix: native.liveProjectRoot,
        globalRoot: path.dirname(native.liveProjectRoot),
        binDir: native.liveBinDir,
      }
    : resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot, {
        allowDirectNodeModulesRoot: params.installTarget.directNodeModulesRoot === true,
      });
  const targetPackageRoot = native
    ? path.join(native.liveProjectRoot, path.relative(native.projectRoot, params.stage.packageRoot))
    : params.installTarget.packageRoot;
  const targetSwapRoot = native?.liveProjectRoot ?? targetPackageRoot;
  const stagedSwapRoot = native?.projectRoot ?? params.stage.packageRoot;
  return { targetLayout, targetPackageRoot, targetSwapRoot, stagedSwapRoot };
}

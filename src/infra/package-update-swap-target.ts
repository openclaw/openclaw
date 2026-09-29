import path from "node:path";
import type { StagedPackageSwapParams } from "./package-update-swap-contract.js";
import { resolveNpmGlobalPrefixLayoutFromGlobalRoot } from "./update-npm-prefix.js";

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

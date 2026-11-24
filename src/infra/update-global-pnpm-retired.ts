import path from "node:path";
import { pathExists } from "../utils.js";
import { realpathOrResolve } from "./path-existence.js";
import {
  inferPnpmGlobalRootFromPackageRoot,
  resolvePnpmGlobalInstallOwner,
} from "./update-global.js";

// 2026.9.33–2026.9.37 updaters import this owner after activation. Keep it while
// that shipped line remains in the supported upgrade window.
export async function isRetiredPnpmGenerationOfInstall(params: {
  entrypoint: string;
  activeRoot: string;
}): Promise<boolean> {
  const parts = path.resolve(params.entrypoint).split(path.sep);
  const store = parts.lastIndexOf(".pnpm");
  if (
    store <= 0 ||
    parts[store - 1] !== "node_modules" ||
    !parts[store + 1]?.startsWith("openclaw@") ||
    parts[store + 2] !== "node_modules" ||
    parts[store + 3] !== "openclaw"
  ) {
    return false;
  }
  const retiredRoot = parts.slice(0, store + 4).join(path.sep);
  const retiredGlobalRoot = inferPnpmGlobalRootFromPackageRoot(retiredRoot);
  const activeGlobalRoot = inferPnpmGlobalRootFromPackageRoot(params.activeRoot);
  if (
    !retiredGlobalRoot ||
    !activeGlobalRoot ||
    (await pathExists(retiredRoot)) ||
    !(await resolvePnpmGlobalInstallOwner(params.activeRoot))
  ) {
    return false;
  }
  return (
    (await realpathOrResolve(retiredGlobalRoot)) === (await realpathOrResolve(activeGlobalRoot))
  );
}

import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../utils.js";
import {
  inferPnpmGlobalRootFromPackageRoot,
  resolvePnpmGlobalInstallOwner,
} from "./update-global.js";

const PRIMARY_PACKAGE_NAME = "openclaw";

async function realpathOrResolved(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/**
 * A launcher path into a pnpm store generation that no longer exists belongs to
 * the active install when both live under the same pnpm global root. pnpm
 * deletes the previous generation during an update, so older updaters left
 * service definitions pointing at it.
 */
export async function isRetiredPnpmGenerationOfInstall(params: {
  entrypoint: string;
  activeRoot: string;
}): Promise<boolean> {
  const parts = path.resolve(params.entrypoint).split(path.sep);
  const store = parts.lastIndexOf(".pnpm");
  if (
    store <= 0 ||
    parts[store - 1] !== "node_modules" ||
    !parts[store + 1]?.startsWith(`${PRIMARY_PACKAGE_NAME}@`) ||
    parts[store + 2] !== "node_modules" ||
    parts[store + 3] !== PRIMARY_PACKAGE_NAME
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
    (await realpathOrResolved(retiredGlobalRoot)) === (await realpathOrResolved(activeGlobalRoot))
  );
}

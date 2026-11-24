import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "./errno.js";
import {
  inferPnpmGlobalRootFromPackageRoot,
  resolvePnpmGlobalInstallOwner,
} from "./update-global.js";

/** Reconcile a deleted pnpm generation only within the verified active install. */
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
  if (!retiredGlobalRoot || !activeGlobalRoot) {
    return false;
  }
  try {
    await fs.lstat(retiredRoot);
    return false;
  } catch (error) {
    if (!isMissingPathError(error)) {
      return false;
    }
  }
  if (!(await resolvePnpmGlobalInstallOwner(params.activeRoot))) {
    return false;
  }
  const [retired, active] = await Promise.all(
    [retiredGlobalRoot, activeGlobalRoot].map((root) => fs.realpath(root).catch(() => null)),
  );
  return retired !== null && retired === active;
}

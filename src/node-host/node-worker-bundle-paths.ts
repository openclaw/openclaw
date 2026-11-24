import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

/** Code belongs to the installed package; node identities and workspaces never live here. */
export function packagedNodeWorkerBundleDirectory(bundleHash: string): string | undefined {
  const packageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  return packageRoot
    ? path.join(packageRoot, "worker-artifacts", "expanded", bundleHash)
    : undefined;
}

/** Only the exact package-owned code target may cross the lease's bundle boundary. */
export function resolveNodeWorkerBundleDirectory(destination: string, bundleHash: string): string {
  if (!fs.lstatSync(destination).isSymbolicLink()) {
    return destination;
  }
  const prepared = packagedNodeWorkerBundleDirectory(bundleHash);
  if (
    !prepared ||
    fs.realpathSync.native(destination) !== prepared ||
    fs.realpathSync.native(prepared) !== prepared
  ) {
    throw new Error("node worker bundle alias does not name its owning package artifact");
  }
  return prepared;
}

import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

export function packagedNodeWorkerBundleDirectory(bundleHash: string): string | undefined {
  const packageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  return packageRoot
    ? path.join(fs.realpathSync.native(packageRoot), "worker-artifacts", "expanded", bundleHash)
    : undefined;
}

/** A lease may alias only the owning package's exact immutable build. */
export function resolveNodeWorkerBundleDirectory(directory: string, bundleHash: string): string {
  const resolved = fs.realpathSync.native(directory);
  if (
    fs.lstatSync(directory).isSymbolicLink() &&
    resolved !== packagedNodeWorkerBundleDirectory(bundleHash)
  ) {
    throw new Error("Worker bundle alias does not target its prepared package build");
  }
  return resolved;
}

import { capturePackageActivationRuntime } from "./package-update-activation-paths.js";
import type { PackageActivationRuntime } from "./package-update-swap-contract.js";

export function packageActivationRuntimeForTest(): PackageActivationRuntime {
  return capturePackageActivationRuntime(process.versions.bun ? "bun" : "node", process.execPath);
}

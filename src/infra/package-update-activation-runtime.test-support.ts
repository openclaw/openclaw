import { capturePackageActivationRuntime } from "./package-update-activation-paths.js";
import type { PackageActivationRuntime } from "./package-update-activation-runtime.types.js";

export function packageActivationRuntimeForTest(): PackageActivationRuntime {
  return capturePackageActivationRuntime(process.versions.bun ? "bun" : "node", process.execPath);
}

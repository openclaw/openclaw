import path from "node:path";
import {
  collectPackageDistInventory,
  readPackageDistContentInventoryIfPresent,
} from "./package-dist-inventory.js";
import {
  applyLocalPackageOverrides,
  captureLocalPackageOverrides,
  prepareLocalOverrideRuntime,
} from "./package-local-overrides.js";
import type { StagedPackageSwapParams } from "./package-update-swap-contract.js";

/** Prepare before drain; invoke only after retaining the old tree and registering rollback. */
export async function preparePackageSwapLocalOverrides(
  params: Pick<
    StagedPackageSwapParams,
    "stage" | "installTarget" | "localOverrides" | "onLocalOverrides"
  > & {
    hadPackage: boolean;
    rootLinked: boolean;
    targetSwapRoot: string;
    backupRoot: string;
  },
): Promise<(() => Promise<void>) | undefined> {
  const packageRoot = params.installTarget.packageRoot;
  const options = params.localOverrides;
  if (!params.hadPackage || params.rootLinked || !options || !packageRoot) {
    return undefined;
  }
  // Reject unsupported topology while the original service can still serve.
  await readPackageDistContentInventoryIfPresent(packageRoot);
  await collectPackageDistInventory(packageRoot, { includePackageExcludedFiles: true });
  const runtimeUrls = options.reapply
    ? await prepareLocalOverrideRuntime({
        sourceRoot: params.targetSwapRoot,
        destinationRoot: params.backupRoot,
      })
    : undefined;
  const retiredPackageRoot = path.join(
    params.backupRoot,
    path.relative(params.targetSwapRoot, packageRoot),
  );
  return async () => {
    // Capture only after the real move, so staging/drain-time edits are included.
    const plan = await captureLocalPackageOverrides({
      packageRoot: retiredPackageRoot,
      recordedPackageRoot: packageRoot,
      env: options.env,
    });
    if (plan) {
      params.onLocalOverrides?.({ ...plan.result, status: "preserved" });
    }
    const result = await applyLocalPackageOverrides({
      packageRoot: params.stage.packageRoot,
      plan,
      reapply: options.reapply,
      runtimeUrls,
    });
    params.onLocalOverrides?.(result);
    if (result.status === "error") {
      throw new Error(
        `Local overrides could not be safely replayed. Recovery bundle: ${result.recoveryDir}`,
      );
    }
  };
}

import { isDeepStrictEqual } from "node:util";
import type { ClawRemoveApplyOptions } from "./lifecycle-remove-contract.js";
import type { ClawPackageRemovalPhaseResult } from "./package-remove-contract.js";
import {
  filterReferencedCleanup,
  digestClawPackageRemovalPlan,
  digestClawRemovalInstall,
  orderClawPackageRemovals,
  normalizeClawPackageCleanup,
} from "./package-remove-plan.js";
import { applyClawPackageRemovals, type ClawPackageRemovalDecision } from "./package-remove.js";
import { readClawInstallRecord } from "./provenance.js";

export async function applyClawPackageRemovalPhase(
  decisions: ClawPackageRemovalDecision[],
  options: ClawRemoveApplyOptions & {
    agentId: string;
    operationId: string;
    assertCurrent: () => void;
  },
): Promise<ClawPackageRemovalPhaseResult> {
  const ordered = orderClawPackageRemovals(decisions);
  options.assertCurrent();
  const cleanup = normalizeClawPackageCleanup(
    filterReferencedCleanup(options.referencedCleanup, "package"),
  );
  if (
    !ordered.some(
      (decision) => decision.packageRef.kind === "plugin" && decision.action === "uninstall",
    )
  ) {
    return await applyClawPackageRemovals(ordered, { ...options, deps: options.packageDeps });
  }
  if (!options.packageGateway) {
    throw new Error("Plugin cleanup requires the serving Gateway package owner.");
  }
  // Hand off before taking either cross-process package mutation lease.
  const removed = await options.packageGateway({
    agentId: options.agentId,
    operationId: options.operationId,
    expectedInstallDigest: digestClawRemovalInstall(
      readClawInstallRecord(options.agentId, options),
    ),
    expectedPackagePlanDigest: digestClawPackageRemovalPlan(ordered, cleanup),
    cleanup,
  });
  options.assertCurrent();
  const expected = ordered.map(({ packageRef }) => [
    packageRef.kind,
    packageRef.ref,
    packageRef.version,
  ]);
  const actual = removed.packages.map((pkg) => [pkg.kind, pkg.ref, pkg.version]);
  if (
    !isDeepStrictEqual(expected, actual) ||
    (removed.packages.some((pkg) => pkg.kind === "plugin" && pkg.action === "uninstalled") &&
      !removed.application)
  ) {
    throw new Error("Gateway package cleanup returned incomplete removal outcomes.");
  }
  return removed;
}

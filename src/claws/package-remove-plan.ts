import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import {
  clawPackageRemovalSelector,
  type ClawPackageInspection,
  type ClawPackageRemovalDecision,
  type ClawReferencedCleanup,
} from "./package-remove.js";
import type { PersistedClawInstall } from "./provenance.js";

export function orderClawPackageRemovals(decisions: ClawPackageRemovalDecision[]) {
  return decisions.toSorted(
    (left, right) =>
      Number(left.packageRef.relationship === "referenced") -
      Number(right.packageRef.relationship === "referenced"),
  );
}

/** Comparison facts only; removers must still validate their current journal and leases. */
export function digestClawRemovalState(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

/** Omitted cleanup options and their defaults must have the same identity across JSON RPC. */
export function normalizeClawPackageCleanup(cleanup?: ClawReferencedCleanup) {
  return {
    mode: cleanup?.mode ?? "retain",
    selected: [...(cleanup?.selected ?? [])],
    allowConflicts: cleanup?.allowConflicts === true,
  };
}

export function digestClawPackageRemovalPlan(
  decisions: ClawPackageRemovalDecision[],
  cleanup: ClawReferencedCleanup,
): string {
  return digestClawRemovalState({
    decisions: orderClawPackageRemovals(decisions),
    cleanup: normalizeClawPackageCleanup(cleanup),
  });
}

export function digestClawRemovalInstall(install: PersistedClawInstall | undefined): string {
  return digestClawRemovalState(install ?? null);
}

type PackageRemoveAction = {
  kind: "packageRef";
  id: string;
  action: "release" | "uninstall";
  target: string;
  blocked: boolean;
  reason?: string;
  details: Record<string, unknown>;
};

type PackageRemoveBlocker = { code: string; message: string };

export function filterReferencedCleanup(
  cleanup: ClawReferencedCleanup | undefined,
  kind: "package" | "mcp",
): ClawReferencedCleanup | undefined {
  return cleanup
    ? {
        ...cleanup,
        selected: (cleanup.selected ?? []).filter(
          (selector) => selector.startsWith("mcp:") === (kind === "mcp"),
        ),
      }
    : undefined;
}

export function projectClawPackageRemovePlan(params: {
  decisions: ClawPackageRemovalDecision[];
  inspections: ClawPackageInspection[];
  cleanup?: ClawReferencedCleanup;
}): { actions: PackageRemoveAction[]; blockers: PackageRemoveBlocker[] } {
  const selected = new Set(params.cleanup?.selected ?? []);
  const blockers: PackageRemoveBlocker[] = [];
  const actions = params.decisions.map((decision): PackageRemoveAction => {
    const pkg = decision.packageRef;
    const selector = clawPackageRemovalSelector(pkg);
    selected.delete(selector);
    if (decision.blocked) {
      blockers.push({
        code: "referenced_cleanup_requires_override",
        message: `${selector}: ${decision.reason ?? "explicit conflict override is required"}`,
      });
    }
    const inspected = params.inspections.find(
      (candidate) =>
        candidate.kind === pkg.kind &&
        candidate.source === pkg.source &&
        candidate.ref === pkg.ref &&
        candidate.version === pkg.version,
    );
    return {
      kind: "packageRef",
      id: selector,
      action: decision.action === "uninstall" ? "uninstall" : "release",
      target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
      blocked: Boolean(decision.blocked),
      details: {
        expectedState: inspected?.state ?? "incomplete",
        status: pkg.status,
        relationship: pkg.relationship,
        origin: pkg.origin,
        introducedByClawAdd: pkg.origin === "claw-introduced",
        independentOwner: pkg.independentOwner,
        affectedClawAgentIds: decision.affectedClawAgentIds,
        cleanupMode: params.cleanup?.mode ?? "retain",
        availableCleanupModes:
          pkg.relationship === "referenced"
            ? ["retain", "remove-if-unused", "remove-selected"]
            : ["remove"],
      },
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  });
  for (const selector of selected) {
    blockers.push({
      code: "referenced_cleanup_not_found",
      message: `Selected referenced resource ${JSON.stringify(selector)} is not owned by this Claw.`,
    });
  }
  return { actions, blockers };
}

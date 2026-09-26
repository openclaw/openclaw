// JOINT path derivation observer.
// Pure function: explicit workspace + explicit relative path → resolved path.
// No nearest-parent fallback. No directory creation. No filesystem authority inference.
// Does not determine CapabilityStatus or ResolutionStatus.
import path from "node:path";
import type { EvidenceRecord } from "../config/zod-schema.registry-validation.js";
import { createEvidenceRecord } from "./observer-evidence.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JointDerivationInput {
  workspace: string;
  relativePath: string;
  /** Derivation rule document (e.g. "JOINT: workspace/<relativePath>"). */
  derivationRule?: string;
}

export interface JointDerivationResult {
  resolvedPath: string | null;
  status: "DERIVED" | "UNAVAILABLE" | "INVALID_PATH" | "REJECTED";
  derivationRule: string;
  evidence: EvidenceRecord[];
  /** Error or rejection reason. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * Derives a JOINT operational path from an explicit workspace and relative path.
 * Platform-safe: uses path.resolve which normalizes separators for the current platform.
 * Preserves the derivation rule as evidence.
 * Rejects absolute child declarations where relative paths are required.
 * Rejects traversal escaping the workspace.
 */
export function deriveJointPath(
  input: JointDerivationInput,
  deps: { now: () => string },
): JointDerivationResult {
  const collectedAt = deps.now();
  const evidence: EvidenceRecord[] = [];
  const rule = input.derivationRule ?? "JOINT: workspace + relativePath → resolvedPath";

  // Validate workspace presence
  if (!input.workspace || input.workspace.trim() === "") {
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source: "joint-derivation",
          collector: "JointDerivationObserver",
          confidence: "LOW",
          value: null,
          notes: "Workspace absent — cannot derive JOINT path",
        },
        collectedAt,
      ),
    );
    return {
      resolvedPath: null,
      status: "UNAVAILABLE",
      derivationRule: rule,
      evidence,
      error: "Workspace is absent",
    };
  }

  // Validate relative path presence
  if (!input.relativePath || input.relativePath.trim() === "") {
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source: "joint-derivation",
          collector: "JointDerivationObserver",
          confidence: "LOW",
          value: null,
          notes: "Relative path absent — cannot derive JOINT path",
        },
        collectedAt,
      ),
    );
    return {
      resolvedPath: null,
      status: "INVALID_PATH",
      derivationRule: rule,
      evidence,
      error: "Relative path is absent",
    };
  }

  const trimmedRelative = input.relativePath.trim();

  // Reject absolute child declarations where relative paths are required
  if (path.isAbsolute(trimmedRelative)) {
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source: "joint-derivation",
          collector: "JointDerivationObserver",
          confidence: "HIGH",
          value: trimmedRelative,
          notes: `Rejected absolute child declaration: ${trimmedRelative}`,
        },
        collectedAt,
      ),
    );
    return {
      resolvedPath: null,
      status: "REJECTED",
      derivationRule: rule,
      evidence,
      error: `Absolute child declaration rejected: ${trimmedRelative}`,
    };
  }

  // Resolve the path
  const resolved = path.resolve(input.workspace, trimmedRelative);

  // Reject traversal escaping the workspace
  const normalizedWorkspace = path.resolve(input.workspace);
  const relativeToWorkspace = path.relative(normalizedWorkspace, resolved);
  if (relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) {
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source: "joint-derivation",
          collector: "JointDerivationObserver",
          confidence: "HIGH",
          value: resolved,
          notes: `Rejected traversal escaping workspace: ${resolved} is outside ${normalizedWorkspace}`,
        },
        collectedAt,
      ),
    );
    return {
      resolvedPath: null,
      status: "REJECTED",
      derivationRule: rule,
      evidence,
      error: `Traversal escape rejected: ${resolved} escapes workspace ${normalizedWorkspace}`,
    };
  }

  // Success — path is within workspace
  evidence.push(
    createEvidenceRecord(
      {
        evidenceType: "CONFIG",
        source: "joint-derivation",
        collector: "JointDerivationObserver",
        confidence: "HIGH",
        value: resolved,
        notes: `Derived JOINT path: ${resolved} (rule: ${rule})`,
      },
      collectedAt,
    ),
  );

  return {
    resolvedPath: resolved,
    status: "DERIVED",
    derivationRule: rule,
    evidence,
    error: null,
  };
}

/**
 * Derives multiple JOINT paths from a single workspace and multiple relative paths.
 * Each path is derived independently. No batch filesystem operations.
 */
export function deriveJointPaths(
  workspace: string,
  relativePaths: string[],
  deps: { now: () => string },
  derivationRule?: string,
): JointDerivationResult[] {
  return relativePaths.map((relativePath) =>
    deriveJointPath({ workspace, relativePath, derivationRule }, deps),
  );
}

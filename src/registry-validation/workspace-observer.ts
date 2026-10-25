// Configured workspace observer.
// Reads workspace from an explicit parsed configuration source or injected parser adapter.
// Does NOT write openclaw.json, does NOT do silent fallback, does NOT select alternate workspaces.
import type { EvidenceRecord } from "../config/zod-schema.registry-validation.js";
import { createEvidenceRecord } from "./observer-evidence.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected config parser adapter — returns parsed config or throws. */
export type ConfigParserAdapter = () => unknown;

export interface WorkspaceObservationResult {
  workspace: string | null;
  present: boolean;
  valid: boolean;
  source: string;
  evidence: EvidenceRecord[];
  /** Error message if parsing or validation failed. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * Observes the configured workspace from an explicit parsed configuration source.
 * Key path: agents.defaults.workspace
 * Preserves Windows paths. No silent fallback. No config mutation.
 */
export function observeWorkspace(
  parser: ConfigParserAdapter,
  deps: { now: () => string },
): WorkspaceObservationResult {
  const collectedAt = deps.now();
  const evidence: EvidenceRecord[] = [];
  let parsedConfig: unknown;

  try {
    parsedConfig = parser();
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source: "config-parser",
          collector: "WorkspaceObserver",
          confidence: "LOW",
          value: null,
          notes: `Parser error: ${parseError}`,
        },
        collectedAt,
      ),
    );
    return {
      workspace: null,
      present: false,
      valid: false,
      source: "config-parser",
      evidence,
      error: parseError,
    };
  }

  // Navigate to agents.defaults.workspace
  const source = "agents.defaults.workspace";
  const { workspace, present, valid, error } = extractWorkspace(parsedConfig);

  if (present && valid && workspace) {
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source,
          collector: "WorkspaceObserver",
          confidence: "HIGH",
          value: workspace,
          notes: `Workspace configured at ${source}`,
        },
        collectedAt,
      ),
    );
  } else if (present && !valid) {
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source,
          collector: "WorkspaceObserver",
          confidence: "LOW",
          value: workspace,
          notes: `Workspace present but invalid: ${error}`,
        },
        collectedAt,
      ),
    );
  } else {
    evidence.push(
      createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source,
          collector: "WorkspaceObserver",
          confidence: "LOW",
          value: null,
          notes: `Workspace not present at ${source}`,
        },
        collectedAt,
      ),
    );
  }

  return {
    workspace: present && valid ? workspace : null,
    present,
    valid,
    source,
    evidence,
    error,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WorkspaceExtractionResult {
  workspace: string | null;
  present: boolean;
  valid: boolean;
  error: string | null;
}

function extractWorkspace(config: unknown): WorkspaceExtractionResult {
  if (config === null || typeof config !== "object") {
    return { workspace: null, present: false, valid: false, error: "Config is not an object" };
  }

  const cfg = config as Record<string, unknown>;
  const agents = cfg.agents;
  if (agents === undefined || agents === null || typeof agents !== "object") {
    return { workspace: null, present: false, valid: false, error: "agents section missing" };
  }

  const agentsObj = agents as Record<string, unknown>;
  const defaults = agentsObj.defaults;
  if (defaults === undefined || defaults === null || typeof defaults !== "object") {
    return { workspace: null, present: false, valid: false, error: "agents.defaults missing" };
  }

  const defaultsObj = defaults as Record<string, unknown>;
  const workspace = defaultsObj.workspace;
  if (workspace === undefined || workspace === null) {
    return { workspace: null, present: false, valid: false, error: null };
  }

  if (typeof workspace !== "string") {
    return {
      workspace: String(workspace),
      present: true,
      valid: false,
      error: `workspace must be a string, got ${typeof workspace}`,
    };
  }

  const trimmed = workspace.trim();
  if (trimmed === "") {
    return { workspace: null, present: true, valid: false, error: "workspace is empty string" };
  }

  // Valid workspace — preserve Windows paths (do not normalize separators)
  return { workspace: trimmed, present: true, valid: true, error: null };
}

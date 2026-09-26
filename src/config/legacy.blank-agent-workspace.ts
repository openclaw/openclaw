// Load-time migration that preserves saved configurations with blank agent
// workspace values. A blank `workspace` (whitespace-only) was historically
// accepted: the runtime trimmed it and fell back to the default workspace
// directory. Once blank workspace is surfaced as a validation error, a saved
// blank would reject config loading entirely. This migration removes such
// blanks during load so existing installations keep loading and keep their
// effective (defaulted) workspace directory.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.openclaw.js";

type BlankWorkspaceMigration<T = unknown> = {
  config: T;
  changed: boolean;
  changes: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
};

function isBlankString(value: unknown): value is string {
  return typeof value === "string" && !value.trim();
}

function removeBlankWorkspaceFromAgent(
  record: Record<string, unknown>,
  path: string,
  changes: ConfigValidationIssue[],
): void {
  if (isRecord(record) && isBlankString(record.workspace)) {
    delete record.workspace;
    changes.push({
      path,
      message: `Removed blank agents.${path}.workspace; the default workspace directory applies.`,
    });
  }
}

function migrateBlankAgentWorkspaceRaw(raw: unknown): BlankWorkspaceMigration {
  if (!isRecord(raw) || !isRecord(raw.agents)) {
    return { config: raw, changed: false, changes: [], warnings: [] };
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  const agents = isRecord(next.agents) ? (next.agents as Record<string, unknown>) : {};
  const changes: ConfigValidationIssue[] = [];

  if (isRecord(agents.defaults) && isBlankString(agents.defaults.workspace)) {
    delete agents.defaults.workspace;
    changes.push({
      path: "agents.defaults.workspace",
      message: "Removed blank agents.defaults.workspace.",
    });
  }

  if (isRecord(agents.entries)) {
    for (const [key, entry] of Object.entries(agents.entries)) {
      removeBlankWorkspaceFromAgent(entry as Record<string, unknown>, `entries.${key}`, changes);
    }
  }

  if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      removeBlankWorkspaceFromAgent(entry as Record<string, unknown>, `list[${index}]`, changes);
    }
  }

  return changes.length > 0
    ? { config: next, changed: true, changes, warnings: [] }
    : { config: raw, changed: false, changes, warnings: [] };
}

export function migrateBlankAgentWorkspace(
  raw: OpenClawConfig,
): BlankWorkspaceMigration<OpenClawConfig>;
export function migrateBlankAgentWorkspace(raw: unknown): BlankWorkspaceMigration;
export function migrateBlankAgentWorkspace(raw: unknown): BlankWorkspaceMigration {
  return migrateBlankAgentWorkspaceRaw(raw);
}

// Explicit skill selections carried across a restart.
//
// Restore must not trust the persisted row: a selection only survives when the
// current workspace catalog still offers the exact skill file it named. This
// owner keeps that bounded projection and its catalog lookup together, apart
// from the general queue persistence codec.
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveWorkspaceSkillPromptEntries } from "../../../skills/loading/workspace-skill-loader.js";
import type { PersistedFollowupRun } from "./persist-codec.js";
import type { FollowupRun } from "./types.js";

const MAX_EXPLICIT_SKILL_SELECTIONS = 32;
const MAX_EXPLICIT_SKILL_NAME_LENGTH = 128;
const MAX_EXPLICIT_SKILL_PATH_LENGTH = 1024;

export type RestoredExplicitSkillSelections = NonNullable<FollowupRun["explicitSkillSelections"]>;
export type ExplicitSkillRestoreResolution =
  | { status: "absent" }
  | { status: "ok"; selections: RestoredExplicitSkillSelections }
  | { status: "invalid" };

function comparableSkillPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function projectExplicitSkillSelections(
  value: unknown,
): RestoredExplicitSkillSelections | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXPLICIT_SKILL_SELECTIONS) {
    return undefined;
  }
  const projected: RestoredExplicitSkillSelections = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const name = normalizeOptionalString(entry.name);
    const skillPath = normalizeOptionalString(entry.path);
    if (
      !name ||
      !skillPath ||
      name.length > MAX_EXPLICIT_SKILL_NAME_LENGTH ||
      skillPath.length > MAX_EXPLICIT_SKILL_PATH_LENGTH
    ) {
      return undefined;
    }
    projected.push({ name, path: skillPath });
  }
  return projected;
}

export function createExplicitSkillRestoreResolver(
  currentConfig: OpenClawConfig,
): (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution {
  const catalogs = new Map<string, Array<{ name: string; path: string }> | null>();
  const loadCatalog = (workspaceDir: string, agentId: string | undefined) => {
    const key = `${workspaceDir}\0${agentId ?? ""}`;
    if (catalogs.has(key)) {
      return catalogs.get(key) ?? null;
    }
    try {
      const eligible = resolveWorkspaceSkillPromptEntries(workspaceDir, {
        config: currentConfig,
        agentId,
      }).eligible.map((entry) => ({
        name: entry.skill.name,
        path: entry.skill.filePath,
      }));
      catalogs.set(key, eligible);
      return eligible;
    } catch {
      catalogs.set(key, null);
      return null;
    }
  };

  return (item: PersistedFollowupRun): ExplicitSkillRestoreResolution => {
    if (item.explicitSkillSelections === undefined) {
      return { status: "absent" };
    }
    const projected = projectExplicitSkillSelections(item.explicitSkillSelections);
    if (!projected) {
      return { status: "invalid" };
    }
    const workspaceDir = normalizeOptionalString(item.run.workspaceDir);
    if (!workspaceDir) {
      return { status: "invalid" };
    }
    const catalog = loadCatalog(workspaceDir, normalizeOptionalString(item.run.agentId));
    if (!catalog) {
      return { status: "invalid" };
    }
    const resolved: RestoredExplicitSkillSelections = [];
    for (const selection of projected) {
      const selectedPath = comparableSkillPath(selection.path);
      const skill = catalog.find(
        (candidate) => comparableSkillPath(candidate.path) === selectedPath,
      );
      if (!skill) {
        return { status: "invalid" };
      }
      resolved.push({ name: skill.name, path: skill.path });
    }
    return { status: "ok", selections: resolved };
  };
}

export function hasInvalidExplicitSkillSelections(
  item: PersistedFollowupRun,
  resolveExplicitSkillSelections: (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution,
): boolean {
  return resolveExplicitSkillSelections(item).status === "invalid";
}

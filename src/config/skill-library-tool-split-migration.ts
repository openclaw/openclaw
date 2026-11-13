// Shared one-shot tool-policy migration for the skill_library split, used by Doctor and config writes.
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeToolPolicyName } from "../agents/tool-policy-shared.js";
import {
  migrateLegacyToolNamePolicies,
  SKILL_LIBRARY_TOOL_SPLIT_MIGRATION,
} from "../commands/doctor/shared/legacy-tool-name-migration.js";
import { TOOL_POLICY_ROOTS } from "../commands/doctor/shared/legacy-tool-policy-scopes.js";

// Personal actions of the pre-split skill_workshop library mode, frozen for this migration.
const PRE_SPLIT_PERSONAL_ACTIONS = [
  "list",
  "read",
  "create",
  "update",
  "share",
  "unshare",
  "transfer",
  "activate",
  "remove",
  "rollback",
] as const;

function hasSkillLibraryToolSplitMigrationMarker(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.meta) &&
    isRecord(value.meta.migrations) &&
    value.meta.migrations.skillLibraryToolSplit === true
  );
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let cursor = root;
  for (const key of path) {
    cursor = Array.isArray(cursor)
      ? cursor[Number(key)]
      : isRecord(cursor) && Object.hasOwn(cursor, key)
        ? cursor[key]
        : undefined;
  }
  return cursor;
}

function withMarker<T extends Record<string, unknown>>(cfg: T, roots: Record<string, unknown>): T {
  const meta = isRecord(cfg.meta) ? cfg.meta : {};
  const migrations = isRecord(meta.migrations) ? meta.migrations : {};
  return {
    ...cfg,
    ...roots,
    meta: { ...meta, migrations: { ...migrations, skillLibraryToolSplit: true } },
  };
}

/**
 * Pre-split, a personal-default library turn narrowed `skill_workshop` to the personal action
 * enum, so the deployment policy granted personal authoring exactly that intersection. A missing
 * or empty intersection granted nothing and gets nothing.
 */
function grantGatewayPolicySkillLibrary(policy: unknown): boolean {
  if (!isRecord(policy) || !Array.isArray(policy.allow) || !isRecord(policy.actions)) {
    return false;
  }
  const allowed = new Set(
    policy.allow.map((entry) => (typeof entry === "string" ? normalizeToolPolicyName(entry) : "")),
  );
  const actionEntries = Object.entries(policy.actions);
  if (
    !allowed.has("skill_workshop") ||
    allowed.has("skill_library") ||
    actionEntries.some(([key]) => normalizeToolPolicyName(key) === "skill_library")
  ) {
    return false;
  }
  const lists = actionEntries
    .filter(([key]) => normalizeToolPolicyName(key) === "skill_workshop")
    .map(([, actions]) => actions);
  if (lists.length === 0 || !lists.every(Array.isArray)) {
    return false;
  }
  const granted = PRE_SPLIT_PERSONAL_ACTIONS.filter((action) =>
    lists.every((actions) => actions.includes(action)),
  );
  if (granted.length === 0) {
    return false;
  }
  policy.allow.push("skill_library");
  policy.actions.skill_library = granted;
  return true;
}

/**
 * Personal-library authoring moved from `skill_workshop` to its own `skill_library` tool. An
 * unmarked config keeps its pre-split coverage once: tool-policy lists naming `skill_workshop`
 * gain `skill_library`, and a `tools.gatewayPolicy` allowing `skill_workshop` grants
 * `skill_library` the personal actions it permitted. Only policy that also exists unchanged in
 * `previousConfig` is pre-split; Doctor passes the config itself. The marker is always recorded,
 * and once present this never touches tool policy again.
 */
export function materializeSkillLibraryToolSplit<T extends Record<string, unknown>>(
  cfg: T,
  previousConfig: unknown = cfg,
): { config: T; changes: string[]; paths: string[] } {
  if (hasSkillLibraryToolSplitMigrationMarker(cfg)) {
    return { config: cfg, changes: [], paths: [] };
  }
  if (hasSkillLibraryToolSplitMigrationMarker(previousConfig)) {
    // Keep the record: a dropped marker would re-run this on post-split policy.
    return { config: withMarker(cfg, {}), changes: [], paths: [] };
  }
  const isPreSplit = (path: readonly string[]) =>
    isDeepStrictEqual(valueAt(previousConfig, path), valueAt(cfg, path));
  const roots: Record<string, unknown> = {};
  const paths: string[] = [];
  for (const root of TOOL_POLICY_ROOTS) {
    if (cfg[root] === undefined) {
      continue;
    }
    const value = structuredClone(cfg[root]);
    const changed = migrateLegacyToolNamePolicies(
      value,
      SKILL_LIBRARY_TOOL_SPLIT_MIGRATION,
      [root],
      isPreSplit,
    );
    if (
      root === "tools" &&
      isRecord(value) &&
      isPreSplit(["tools", "gatewayPolicy"]) &&
      grantGatewayPolicySkillLibrary(value.gatewayPolicy)
    ) {
      changed.push("tools.gatewayPolicy");
    }
    if (changed.length > 0) {
      roots[root] = value;
      paths.push(...changed);
    }
  }
  return {
    config: withMarker(cfg, roots),
    paths,
    changes:
      paths.length > 0
        ? [
            `Added skill_library beside skill_workshop in ${paths.join(", ")}; personal-library authoring moved to its own tool.`,
          ]
        : [],
  };
}

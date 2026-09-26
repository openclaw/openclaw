// Repairs tool policy scopes that set both allow and alsoAllow, which config validation rejects.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { hasAgentRosterProperty } from "../../../agents/agent-roster.js";
import {
  normalizeToolProviderPolicyKey,
  resolveProviderToolPolicyEntry,
} from "../../../agents/provider-tool-policy.js";
import { createToolPolicyMatcher } from "../../../agents/tool-policy-match.js";
import { normalizeToolList, resolveToolProfilePolicy } from "../../../agents/tool-policy-shared.js";
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";
import { visitAgentEntries } from "./legacy-config-record-shared.js";
import { isToolPolicyPath, TOOL_POLICY_ROOTS } from "./legacy-tool-policy-scopes.js";

type PolicyRecord = Record<string, unknown>;
type Conflict = { scope: PolicyRecord; path: string; allow: string[]; alsoAllow: string[] };

/** Capture independent profile/extras inheritance before changing any supplier. */
function collectProfileConsumers(raw: PolicyRecord): Map<object, unknown[]> {
  const consumers = new Map<object, unknown[]>();
  const globalTools = getRecord(raw.tools);
  const agentTools: Array<PolicyRecord | null> = [null];
  visitAgentEntries(raw, (entry) => agentTools.push(getRecord(entry.tools)));
  if (!hasAgentRosterProperty(raw)) {
    agentTools.push(getRecord(getRecord(getRecord(raw.agents)?.defaults)?.tools));
  }
  const add = (global: PolicyRecord | null, agent: PolicyRecord | null) => {
    const supplier = Array.isArray(agent?.alsoAllow)
      ? agent
      : Array.isArray(global?.alsoAllow)
        ? global
        : undefined;
    if (supplier) {
      const profiles = consumers.get(supplier) ?? [];
      profiles.push(agent?.profile ?? global?.profile);
      consumers.set(supplier, profiles);
    }
  };
  for (const agent of agentTools) {
    add(globalTools, agent);
    const globalProviders = getRecord(globalTools?.byProvider) ?? undefined;
    const agentProviders = getRecord(agent?.byProvider) ?? undefined;
    const contexts = new Set<string>();
    for (const key of [
      ...Object.keys(globalProviders ?? {}),
      ...Object.keys(agentProviders ?? {}),
    ]) {
      const normalized = normalizeToolProviderPolicyKey(key);
      const slash = normalized.indexOf("/");
      contexts.add(normalized);
      contexts.add(slash < 0 ? normalized : normalized.slice(0, slash));
    }
    for (const context of contexts) {
      const slash = context.indexOf("/");
      const selection = {
        modelProvider: slash < 0 ? context : context.slice(0, slash),
        modelId: slash < 0 ? undefined : context.slice(slash + 1),
      };
      const global = resolveProviderToolPolicyEntry({ ...selection, byProvider: globalProviders });
      const local = resolveProviderToolPolicyEntry({ ...selection, byProvider: agentProviders });
      add(getRecord(global?.policy), getRecord(local?.policy));
    }
  }
  return consumers;
}

function profileDoesNotNeedExtras(profile: unknown, extras: string[]): boolean {
  if (profile === undefined || profile === null) {
    return true;
  }
  if (typeof profile !== "string") {
    return false;
  }
  const policy = resolveToolProfilePolicy(profile);
  if (!policy?.allow) {
    return false;
  }
  if (policy.allow.includes("*")) {
    return true;
  }
  const normalized = normalizeToolList(extras);
  // Limited profiles require an explicit gateway extra for configuration reads.
  if (normalized.length > 0 && createToolPolicyMatcher({ allow: normalized })("gateway")) {
    return false;
  }
  // Prove symbolic containment, not membership in today's finite tool catalog:
  // plugin IDs and globs can expand differently when more tools are loaded.
  const profileTokens = new Set(normalizeToolList(policy.allow));
  return normalized.every((entry) => profileTokens.has(entry));
}

function readGrantList(
  scope: Record<string, unknown>,
  key: "allow" | "alsoAllow",
): string[] | null {
  const list = scope[key];
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  return list.every((entry) => typeof entry === "string") ? list : null;
}

function visitConflictingToolPolicies(value: unknown, path: string[], conflicts: Conflict[]): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      visitConflictingToolPolicies(entry, [...path, String(index)], conflicts);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  // Sandbox allow and alsoAllow inherit independently; merging either scope can widen grants.
  if (path.at(-2) === "tools" && path.at(-1) === "sandbox") {
    return;
  }
  if (isToolPolicyPath(path)) {
    const allow = readGrantList(value, "allow");
    const alsoAllow = readGrantList(value, "alsoAllow");
    if (allow && alsoAllow) {
      const label = path.reduce(
        (prefix, key) =>
          /^[a-zA-Z_$][\w$]*$/.test(key)
            ? `${prefix}${prefix ? "." : ""}${key}`
            : `${prefix}[${JSON.stringify(key)}]`,
        "",
      );
      conflicts.push({ scope: value, path: label, allow, alsoAllow });
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    visitConflictingToolPolicies(entry, [...path, key], conflicts);
  }
}

/** Reports tool policy scopes that set both allow and alsoAllow, without changing them. */
function findConflicts(value: unknown, path: string[]): Conflict[] {
  const conflicts: Conflict[] = [];
  visitConflictingToolPolicies(value, path, conflicts);
  return conflicts;
}

/** Explain unresolved intent through Doctor's finding channel, without claiming a repair. */
export function collectToolPolicyConflictWarnings(raw: unknown): string[] {
  if (!isRecord(raw)) {
    return [];
  }
  return TOOL_POLICY_ROOTS.flatMap((root) =>
    findConflicts(raw[root], [root]).map(({ path, allow, alsoAllow }) => {
      const merged = uniqueStrings([...allow, ...alsoAllow]);
      return (
        `Left ${path}.allow=${JSON.stringify(allow)} and ${path}.alsoAllow=${JSON.stringify(alsoAllow)} unchanged: ` +
        "merging may change profile grants or Gateway configuration-read access. " +
        `To choose the profile plus its explicit extras, remove ${path}.allow (may broaden the explicit restriction). ` +
        `To choose the merged allowlist without profile extras, set ${path}.allow=${JSON.stringify(merged)} and ` +
        `${path}.alsoAllow=[] (may remove profile grants). Review these permissions before choosing.`
      );
    }),
  );
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_POLICY_CONFLICTS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "tools.allow-also-allow-conflict",
    describe: "Merge tool policy alsoAllow grants into allow when a scope sets both",
    legacyRules: TOOL_POLICY_ROOTS.map((root) => ({
      path: [root],
      message:
        'Tool policy sets both allow and alsoAllow in the same scope; run "openclaw doctor --fix" for a permission-preserving repair or manual guidance.',
      match: (value) => findConflicts(value, [root]).length > 0,
    })),
    apply: (raw, changes) => {
      if (!isRecord(raw)) {
        return;
      }
      const consumers = collectProfileConsumers(raw);
      for (const root of TOOL_POLICY_ROOTS) {
        for (const { scope, path, allow, alsoAllow } of findConflicts(raw[root], [root])) {
          if (
            !(consumers.get(scope) ?? []).every((profile) =>
              profileDoesNotNeedExtras(profile, alsoAllow),
            )
          ) {
            continue;
          }
          scope.allow = uniqueStrings([...allow, ...alsoAllow]);
          // An empty array still overrides inherited extras; deleting it can widen permissions.
          scope.alsoAllow = [];
          changes.push(`Merged ${path}.alsoAllow into ${path}.allow.`);
        }
      }
    },
  }),
];

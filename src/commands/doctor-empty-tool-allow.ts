import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentEntriesWithSource } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding } from "../security/audit.types.js";

const BARE_POLICY_KEYS = new Set(["allow", "alsoAllow", "deny", "profile"]);

type PolicySlot = {
  path: string;
  policy: unknown;
  /** True only for `tools.subagents.tools`, where `[]` + `alsoAllow` narrows. */
  alsoAllowNarrows: boolean;
};

function isNonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function segment(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function sortedEntries(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right));
}

/**
 * Channel group, room, and direct configs reuse `tools` / `toolsBySender` for
 * the same allow/deny matcher. A bare policy object is only those fields, so
 * containers such as `gatewayPolicy` or `message.actions` stay out of this walk.
 */
function isBareToolPolicy(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => BARE_POLICY_KEYS.has(key));
}

/**
 * True when explicit `allow: []` reads as deny-all but adds no restriction.
 * A non-empty deny or a profile is a real restriction, so Doctor stays silent.
 * `alsoAllow` suppresses the note only where that scope merges it into `[]`.
 */
function looksLikeIntendedDenyAll(
  policy: unknown,
  alsoAllowNarrows: boolean,
): policy is Record<string, unknown> {
  if (!isRecord(policy) || !Array.isArray(policy.allow) || policy.allow.length > 0) {
    return false;
  }
  if (isNonEmptyList(policy.deny)) {
    return false;
  }
  if (alsoAllowNarrows && isNonEmptyList(policy.alsoAllow)) {
    return false;
  }
  if (typeof policy.profile === "string" && policy.profile.length > 0) {
    return false;
  }
  return true;
}

function pushToolRoot(
  slots: PolicySlot[],
  path: string,
  tools: unknown,
  includeSubagents: boolean,
): void {
  if (tools === undefined) {
    return;
  }
  slots.push({ path, policy: tools, alsoAllowNarrows: false });
  if (!isRecord(tools)) {
    return;
  }
  for (const [key, policy] of sortedEntries(tools.byProvider)) {
    slots.push({ path: `${path}.byProvider${segment(key)}`, policy, alsoAllowNarrows: false });
  }
  for (const [key, policy] of sortedEntries(tools.toolsBySender)) {
    slots.push({ path: `${path}.toolsBySender${segment(key)}`, policy, alsoAllowNarrows: false });
  }
  const sandbox = tools.sandbox;
  if (isRecord(sandbox) && sandbox.tools !== undefined) {
    slots.push({ path: `${path}.sandbox.tools`, policy: sandbox.tools, alsoAllowNarrows: false });
  }
  if (!includeSubagents) {
    return;
  }
  const subagents = tools.subagents;
  if (isRecord(subagents) && subagents.tools !== undefined) {
    slots.push({
      path: `${path}.subagents.tools`,
      policy: subagents.tools,
      alsoAllowNarrows: true,
    });
  }
}

function visitChannelNode(slots: PolicySlot[], path: string, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  if (isBareToolPolicy(value.tools)) {
    slots.push({ path: `${path}.tools`, policy: value.tools, alsoAllowNarrows: false });
  }
  for (const [key, policy] of sortedEntries(value.toolsBySender)) {
    if (!isBareToolPolicy(policy)) {
      continue;
    }
    slots.push({ path: `${path}.toolsBySender${segment(key)}`, policy, alsoAllowNarrows: false });
  }
  for (const [key, child] of sortedEntries(value)) {
    if (key === "tools" || key === "toolsBySender") {
      continue;
    }
    visitChannelNode(slots, `${path}${segment(key)}`, child);
  }
}

function collectPolicySlots(cfg: OpenClawConfig): PolicySlot[] {
  const slots: PolicySlot[] = [];
  pushToolRoot(slots, "tools", cfg.tools, true);
  for (const { entry, source } of listAgentEntriesWithSource(cfg)) {
    const path =
      source.kind === "entries"
        ? `agents.entries.${source.key}.tools`
        : `agents.list.${source.index}.tools`;
    pushToolRoot(slots, path, entry.tools, false);
  }
  visitChannelNode(slots, "channels", cfg.channels);
  return slots;
}

function detailFor(path: string, policy: Record<string, unknown>): string {
  const alsoAllowNote = isNonEmptyList(policy.alsoAllow)
    ? " alsoAllow does not narrow an empty allow in this scope."
    : "";
  return (
    `${path}.allow is [] with no deny or profile, so the empty list adds no restriction at this layer.` +
    `${alsoAllowNote} Other deny lists still apply, and hidden sub-agents keep their built-in denies.`
  );
}

function remediationFor(path: string): string {
  const denyAll = `If you meant "no tools", set ${path}.deny to ["*"].`;
  if (!path.endsWith(".sandbox.tools")) {
    return [
      denyAll,
      "If allow-all is intended, remove the empty allow list; behavior is the same.",
    ].join("\n");
  }
  // pickConfiguredList keeps an explicit [] and only then falls through.
  // Dropping an agent sandbox allow inherits tools.sandbox.tools, including
  // another [], instead of the built-in default.
  const removal =
    path === "tools.sandbox.tools"
      ? `Removing ${path}.allow restores the built-in sandbox default allowlist.`
      : `Removing ${path}.allow restores the inherited global sandbox allow list, or the built-in default when none is configured.`;
  return [denyAll, `${removal} An explicit [] is allow-all at this layer, not that default.`].join(
    "\n",
  );
}

/**
 * Doctor hint for `allow: []` tool policies that look like deny-all was
 * intended. Advisory only: config validation and runtime matching are
 * unchanged, and `allow: []` stays a supported allow-all setting. Refs #147342.
 */
export function collectEmptyToolAllowHints(cfg: OpenClawConfig): SecurityAuditFinding[] {
  return collectPolicySlots(cfg).flatMap((slot) => {
    if (!looksLikeIntendedDenyAll(slot.policy, slot.alsoAllowNarrows)) {
      return [];
    }
    return [
      {
        checkId: "doctor.empty_tool_allow",
        severity: "info" as const,
        title: "Note",
        detail: detailFor(slot.path, slot.policy),
        remediation: remediationFor(slot.path),
      },
    ];
  });
}

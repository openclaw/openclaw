import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentEntriesWithSource } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding } from "../security/audit.types.js";

function isNonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * True only when `allow: []` is the whole policy: no deny, no alsoAllow and no
 * profile. That shape restricts nothing yet reads as "no tools", so the
 * author most likely meant deny-all. Any sibling restriction means the empty
 * list is a deliberate part of a larger policy, and Doctor stays silent.
 */
function looksLikeIntendedDenyAll(policy: unknown): boolean {
  if (!isRecord(policy) || !Array.isArray(policy.allow) || policy.allow.length > 0) {
    return false;
  }
  if (isNonEmptyList(policy.deny) || isNonEmptyList(policy.alsoAllow)) {
    return false;
  }
  return typeof policy.profile !== "string" || policy.profile.length === 0;
}

/**
 * Doctor hint for `allow: []` tool policies that look like deny-all was
 * intended. Advisory only: config validation and runtime matching are
 * unchanged, and `allow: []` stays a supported allow-all setting. Refs #147342.
 */
export function collectEmptyToolAllowHints(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const scopes: { path: string; policy: unknown }[] = [
    { path: "tools", policy: cfg.tools },
    { path: "tools.subagents.tools", policy: cfg.tools?.subagents?.tools },
    ...listAgentEntriesWithSource(cfg).map(({ entry, source }) => ({
      path:
        source.kind === "entries"
          ? `agents.entries.${source.key}.tools`
          : `agents.list.${source.index}.tools`,
      policy: entry.tools,
    })),
  ];
  return scopes
    .filter(({ policy }) => looksLikeIntendedDenyAll(policy))
    .map(({ path }) => ({
      checkId: "doctor.empty_tool_allow",
      severity: "info",
      title: "Note",
      detail: `${path}.allow is [] with no deny, alsoAllow or profile, so every tool stays allowed.`,
      remediation: [
        `If you meant "no tools", set ${path}.deny to ["*"].`,
        "If allow-all is intended, remove the empty allow list; behavior is the same.",
      ].join("\n"),
    }));
}

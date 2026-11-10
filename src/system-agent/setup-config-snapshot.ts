import { listAgentEntries } from "../agents/agent-roster.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { shortenHomePath } from "../utils.js";
import { isReservedSystemAgentId } from "./agent-id.js";

/** Config-only diagnostic shared by setup admission and agent capability guidance. */
export function describeSystemAgentConfigConflict(config: OpenClawConfig): string | undefined {
  const reservedAgent = listAgentEntries(config).find((entry) => isReservedSystemAgentId(entry.id));
  if (!reservedAgent) {
    return undefined;
  }
  return (
    `Agent id "${normalizeAgentId(reservedAgent.id)}" is reserved for the system agent. ` +
    "This configured agent conflicts with managed setup; Full Access or a tool allowlist does not resolve this collision. " +
    "Ask the Gateway operator to migrate it to a non-reserved id, preserving its workspace, sessions, bindings, and credentials. " +
    "Do not simply rename its config key or delete its state."
  );
}

export function requireValidSystemAgentSetupSnapshot(snapshot: ConfigFileSnapshot): {
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
} {
  if (snapshot.exists && !snapshot.valid) {
    const issue = snapshot.issues?.[0];
    const detail = issue ? ` (${issue.path ? `${issue.path}: ` : ""}${issue.message})` : "";
    throw new Error(
      `OpenClaw config ${shortenHomePath(snapshot.path)} is invalid${detail}. Fix it before running setup.`,
    );
  }
  const sourceConfig = snapshot.exists ? (snapshot.sourceConfig ?? snapshot.config) : {};
  const runtimeConfig = snapshot.exists ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const conflict = describeSystemAgentConfigConflict(runtimeConfig);
  if (conflict) {
    throw new Error(conflict);
  }
  return { sourceConfig, runtimeConfig };
}

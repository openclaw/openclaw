import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { shortenHomePath } from "../utils.js";

const CRESTODIAN_AGENT_ID = normalizeAgentId("crestodian");

export function requireValidCrestodianSetupSnapshot(snapshot: ConfigFileSnapshot): {
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
  if (
    runtimeConfig.agents?.list?.some((entry) => normalizeAgentId(entry.id) === CRESTODIAN_AGENT_ID)
  ) {
    throw new Error(
      'Agent id "crestodian" is reserved for the setup assistant. Rename that configured agent, then retry setup.',
    );
  }
  return { sourceConfig, runtimeConfig };
}

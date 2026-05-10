import { listAgentEntries, resolveAgentConfig } from "../agents/agent-scope.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

/**
 * Detect heartbeat configs that pin a non-existent session. The runtime
 * resolves `heartbeat.session` to a sessionKey via `resolveHeartbeatSession`;
 * if the entry is missing, `resolveHeartbeatDeliveryTarget` falls back to
 * `{channel:"none", reason:"no-target"}` and the heartbeat fires a model
 * call whose reply has nowhere to land. Common cause: the configured Slack
 * channel ID does not match any channel the agent has ever joined (e.g.,
 * heartbeat pins channel `c0b2eddpw95` but the agent only has sessions in
 * `c0ag7jag35g`, or the agent has no Slack bot at all).
 *
 * Warning only — repair would mean rewriting the config, which is the
 * operator's intent to express.
 */
export function describeHeartbeatSessionTargetIssues(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];
  const sessionScope = cfg.session?.scope ?? "per-sender";
  for (const agentEntry of listAgentEntries(cfg)) {
    const agentId = typeof agentEntry.id === "string" ? agentEntry.id.trim() : "";
    if (!agentId) {
      continue;
    }
    const agentConfig = resolveAgentConfig(cfg, agentId);
    const heartbeatConfig = agentConfig?.heartbeat;
    if (!heartbeatConfig) {
      continue;
    }
    const configuredSession = normalizeOptionalString(heartbeatConfig.session);
    if (!configuredSession) {
      continue;
    }
    const normalizedSession = configuredSession.toLowerCase();
    // `main` / `global` resolve to the agent main session via
    // `resolveHeartbeatSession`; missing entries fall back to the same key
    // and are repaired elsewhere — don't double-warn here.
    if (normalizedSession === "main" || normalizedSession === "global") {
      continue;
    }
    if (isSubagentSessionKey(configuredSession)) {
      continue;
    }
    const target = normalizeOptionalString(heartbeatConfig.target);
    if (target === "none") {
      continue;
    }
    const storeAgentId = sessionScope === "global" ? "main" : agentId;
    const storePath = resolveStorePath(cfg.session?.store, { agentId: storeAgentId });
    const store = loadSessionStore(storePath);
    const entry = store[configuredSession];
    if (entry) {
      continue;
    }
    warnings.push(
      [
        `- Agent ${agentId} heartbeat.session pins ${configuredSession} but that session has no entry in ${storePath}.`,
        `  Heartbeats will run but resolve delivery to channel="none"/reason="no-target", so replies are dropped silently.`,
        `  Fix: point heartbeat.session at a session the agent actually owns, set heartbeat.target="none" to suppress delivery, or remove the heartbeat.session field to fall back to the agent main session.`,
      ].join("\n"),
    );
  }
  return warnings;
}

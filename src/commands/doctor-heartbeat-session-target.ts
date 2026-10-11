import fs from "node:fs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProactiveDeliveryTarget } from "../infra/outbound/targets.js";
import { loadLegacySessionStore } from "../infra/state-migrations.legacy-session-store.js";
import { resolveAgentIdFromSessionKey, toAgentStoreSessionKey } from "../routing/session-key.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { resolveHeartbeatAgents, resolveHeartbeatIntervalMs } from "./doctor-heartbeat-legacy.js";

/** Warn without rewriting an operator's legacy session or delivery target. */
export async function describeHeartbeatSessionTargetIssues(cfg: OpenClawConfig): Promise<string[]> {
  const warnings: string[] = [];
  const sessionScope = cfg.session?.scope ?? "per-sender";
  for (const { agentId, heartbeat: heartbeatConfig } of resolveHeartbeatAgents(cfg)) {
    if (!heartbeatConfig || !resolveHeartbeatIntervalMs(cfg, undefined, heartbeatConfig)) {
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
    if (
      normalizedSession === "main" ||
      normalizedSession === "global" ||
      isSubagentSessionKey(configuredSession) ||
      sessionScope === "global"
    ) {
      continue;
    }
    const target = normalizeOptionalString(heartbeatConfig.target);
    if (target === "none") {
      continue;
    }
    const deliveryWithoutSession = await resolveProactiveDeliveryTarget({
      cfg,
      agentId,
      policy: heartbeatConfig,
    });
    if (deliveryWithoutSession.channel !== "none" && deliveryWithoutSession.to) {
      continue;
    }
    const candidateSession = toAgentStoreSessionKey({
      agentId,
      requestKey: configuredSession,
      mainKey: cfg.session?.mainKey,
    });
    if (isSubagentSessionKey(candidateSession)) {
      continue;
    }
    const canonicalSession = canonicalizeMainSessionAlias({
      cfg,
      agentId,
      sessionKey: candidateSession,
    });
    if (
      canonicalSession === "global" ||
      isSubagentSessionKey(canonicalSession) ||
      resolveAgentIdFromSessionKey(canonicalSession) !== agentId
    ) {
      continue;
    }
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const source = captureIncognitoSessionSource({
      agentId,
      sessionKey: canonicalSession,
      storePath,
    });
    const entry =
      (await readSessionEntryReadOnlyInWorker({
        agentId,
        sessionKey: canonicalSession,
        storePath,
      })) ??
      (!source && !storePath.endsWith(".sqlite") && fs.existsSync(storePath)
        ? loadLegacySessionStore(storePath)[canonicalSession]
        : undefined);
    if (entry) {
      continue;
    }
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId,
    }).path;
    const ownerTarget = target === undefined || target === "owner";
    const missingRouteOutcome = ownerTarget
      ? "  After migration, the automation uses standard delivery handling; a missing owner route can cause a delivery failure instead of skipping the run."
      : "  After migration, the automation uses standard delivery handling; a missing session route or recipient can cause a delivery failure instead of skipping the run.";
    const fix = ownerTarget
      ? `  Fix: set commands.ownerAllowFrom=["telegram:123456789"] or a channel allowFrom to a direct-message owner; for explicit delivery, set heartbeat.target="telegram" with heartbeat.to="123456789"; use heartbeat.target="none" to suppress delivery.`
      : `  Fix: point heartbeat.session at a session the agent actually owns, set heartbeat.target="none" to suppress delivery, or remove the heartbeat.session field to fall back to the agent main session.`;
    warnings.push(
      [
        `- Agent ${agentId} heartbeat.session pins ${configuredSession} (resolved to ${canonicalSession}) but that session has no entry in ${databasePath}.`,
        missingRouteOutcome,
        fix,
      ].join("\n"),
    );
  }
  return warnings;
}

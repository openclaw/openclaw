import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
// Read-only reset decision shared by Talk call starts and voice consults (#185942).
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";

/**
 * The configured reset reason due for a voice session, if any. Read-only: Talk calls use it to keep
 * a stale session's history out of a new call, and consults use it before rolling the session over.
 * Blocked (archived, recovery tombstone, provider review) and model-locked sessions never reset here.
 */
export async function resolveDueVoiceSessionReset(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry | undefined;
}): Promise<"daily" | "idle" | undefined> {
  const { cfg, agentId, sessionKey, storePath, entry } = params;
  if (!entry?.sessionId?.trim() || isModelSelectionLocked(entry)) {
    return undefined;
  }
  const [
    { resolveSessionEntryResetFreshnessAsync },
    { resolveChannelResetConfig, resolveSessionResetType },
    { resolveSessionWorkStartError },
  ] = await Promise.all([
    import("../config/sessions/entry-freshness.js"),
    import("../config/sessions/reset.js"),
    import("../config/sessions/lifecycle.js"),
  ]);
  if (resolveSessionWorkStartError(sessionKey, entry)) {
    return undefined;
  }
  const resolved = await resolveSessionEntryResetFreshnessAsync({
    agentId,
    sessionKey,
    storePath,
    sessionCfg: cfg.session,
    resetType: resolveSessionResetType({ sessionKey }),
    resetOverride: resolveChannelResetConfig({
      sessionCfg: cfg.session,
      channel: deliveryContextFromSession(entry)?.channel,
    }),
  });
  return resolved.state === "stale" ? resolved.freshness.staleReason : undefined;
}

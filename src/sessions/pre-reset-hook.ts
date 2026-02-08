import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { resolveSessionTranscriptCandidates } from "../gateway/session-utils.fs.js";
import { logDebug, logInfo, logWarn } from "../logger.js";

/**
 * Run the pre-reset hook (best-effort, non-blocking) before a session reset.
 * Triggers an agent turn with the configured prompt so the agent can write
 * notes to memory before the session is cleared.
 *
 * Returns `true` if the hook ran (regardless of outcome), `false` if skipped.
 */
export async function runPreResetHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  storePath?: string;
  agentId?: string;
}): Promise<boolean> {
  const { cfg, sessionKey, sessionEntry, storePath, agentId } = params;
  const preResetConfig = cfg.session?.preReset;
  if (!preResetConfig?.enabled || !preResetConfig.prompt) {
    return false;
  }

  const timeoutSeconds = preResetConfig.timeoutSeconds ?? 30;
  const timeoutMs = timeoutSeconds * 1000;

  // Check if we should skip due to empty session
  if (preResetConfig.skipIfEmpty !== false) {
    const sessionId = sessionEntry?.sessionId;
    if (!sessionId) {
      logDebug(`[pre-reset] Skipping hook for session ${sessionKey} (no session id)`);
      return false;
    }
    const candidates = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      sessionEntry?.sessionFile,
      agentId,
    );
    const transcriptPath = candidates.find((c) => fs.existsSync(c));
    if (!transcriptPath) {
      logDebug(`[pre-reset] Skipping hook for session ${sessionKey} (no transcript)`);
      return false;
    }
    try {
      const stat = fs.statSync(transcriptPath);
      if (stat.size < 100) {
        logDebug(`[pre-reset] Skipping hook for session ${sessionKey} (transcript too small)`);
        return false;
      }
    } catch {
      logDebug(`[pre-reset] Skipping hook for session ${sessionKey} (transcript stat failed)`);
      return false;
    }
  }

  logInfo(`[pre-reset] Running pre-reset hook for session: ${sessionKey}`);
  try {
    await Promise.race([
      callGateway({
        method: "agent",
        params: {
          message: preResetConfig.prompt,
          sessionKey,
          deliver: false,
          lane: "pre-reset",
          idempotencyKey: randomUUID(),
        },
        timeoutMs: timeoutMs + 5000,
        expectFinal: true,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("pre-reset timeout")), timeoutMs),
      ),
    ]);
    logInfo(`[pre-reset] Hook completed successfully for session: ${sessionKey}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(
      `[pre-reset] Hook failed for session ${sessionKey}: ${message} (continuing with reset)`,
    );
  }
  return true;
}

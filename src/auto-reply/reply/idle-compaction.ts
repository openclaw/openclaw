/**
 * Idle-triggered proactive compaction.
 *
 * After each agent turn, if context usage exceeds `idleTriggerPercent` and
 * `idleTriggerMinutes` is configured, we schedule a timer. If no new message
 * arrives before the timer fires, compaction runs proactively rather than
 * waiting for the context window to overflow.
 *
 * The timer is cancelled whenever a new inbound message is received.
 */
import type { OpenClawConfig } from "../../config/config.js";
import type { CompactEmbeddedPiSessionParams } from "../../agents/pi-embedded-runner/compact.js";
import { compactEmbeddedPiSession } from "../../agents/pi-embedded.js";
import { defaultRuntime } from "../../runtime.js";

/** Map<sessionKey, NodeJS.Timeout> */
const pendingIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

let exitHandlerRegistered = false;

function ensureExitHandler() {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on("exit", () => {
    for (const timer of pendingIdleTimers.values()) {
      clearTimeout(timer);
    }
    pendingIdleTimers.clear();
  });
}

export type ScheduleIdleCompactionParams = {
  /** Session key (routing key used as timer map key). */
  sessionKey: string;
  /** Session id passed to compactEmbeddedPiSession. */
  sessionId: string;
  /** Actual prompt tokens consumed this turn. */
  contextTokensUsed: number;
  /** Session's max context window size. */
  contextTokensMax: number;
  /** Full OpenClaw config (for reading compaction settings). */
  cfg: OpenClawConfig;
  // Additional fields forwarded to compactEmbeddedPiSession
  sessionFile: string;
  workspaceDir: string;
  provider?: string;
  model?: string;
  thinkLevel?: CompactEmbeddedPiSessionParams["thinkLevel"];
  bashElevated?: CompactEmbeddedPiSessionParams["bashElevated"];
  skillsSnapshot?: CompactEmbeddedPiSessionParams["skillsSnapshot"];
  ownerNumbers?: string[];
};

/**
 * Schedule a proactive idle compaction for `sessionKey`.
 *
 * No-ops when:
 * - `idleTriggerMinutes` is not configured
 * - `contextTokensUsed / contextTokensMax` is below `idleTriggerPercent`
 *
 * Replaces any previously scheduled timer for this session.
 */
export function scheduleIdleCompaction(params: ScheduleIdleCompactionParams): void {
  const { cfg, sessionKey, sessionId, contextTokensUsed, contextTokensMax } = params;

  const compactionCfg = cfg?.agents?.defaults?.compaction;
  const idleTriggerMinutes = compactionCfg?.idleTriggerMinutes;
  const idleTriggerPercent = compactionCfg?.idleTriggerPercent ?? 0.7;

  // Feature disabled — nothing to do.
  if (!idleTriggerMinutes) {
    return;
  }

  // Check whether we're above the threshold.
  const percent = contextTokensMax > 0 ? contextTokensUsed / contextTokensMax : 0;
  if (percent < idleTriggerPercent) {
    return;
  }

  // Replace any stale timer.
  cancelIdleCompaction(sessionKey);
  ensureExitHandler();

  const delayMs = idleTriggerMinutes * 60 * 1000;

  const timer = setTimeout(async () => {
    pendingIdleTimers.delete(sessionKey);
    try {
      await compactEmbeddedPiSession({
        sessionId,
        sessionKey,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        config: params.cfg,
        provider: params.provider,
        model: params.model,
        thinkLevel: params.thinkLevel,
        bashElevated: params.bashElevated,
        skillsSnapshot: params.skillsSnapshot,
        ownerNumbers: params.ownerNumbers,
        trigger: "manual",
      });
      defaultRuntime.log(
        `[idle-compaction] Idle compaction completed for session ${sessionKey}`,
      );
    } catch (err) {
      // Best-effort: errors must not affect the main reply flow.
      defaultRuntime.error(
        `[idle-compaction] Idle compaction failed for session ${sessionKey}: ${String(err)}`,
      );
    }
  }, delayMs);

  pendingIdleTimers.set(sessionKey, timer);
}

/**
 * Cancel a pending idle compaction timer for `sessionKey` (e.g. when a new
 * inbound message arrives).
 */
export function cancelIdleCompaction(sessionKey: string): void {
  const timer = pendingIdleTimers.get(sessionKey);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingIdleTimers.delete(sessionKey);
  }
}

import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

// Type for the updateSessionStoreEntry function from sessions.js
type UpdateSessionStoreEntryFn = (params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}) => Promise<SessionEntry | null>;

export type ThinkingEscalationParams = {
  cfg: OpenClawConfig | undefined;
  sessionEntry: SessionEntry | undefined;
  sessionStore: Record<string, SessionEntry> | undefined;
  sessionKey: string | undefined;
  storePath: string | undefined;
  contextTokensUsed: number | undefined;
  totalTokens: number | undefined;
  currentThinkLevel: ThinkLevel | undefined;
};

// Order of thinking levels from lowest to highest
const THINKING_LEVEL_ORDER: ThinkLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function getThinkingLevelIndex(level: ThinkLevel | undefined): number {
  if (!level) {
    return -1;
  }
  return THINKING_LEVEL_ORDER.indexOf(level);
}

function shouldEscalate(
  currentLevel: ThinkLevel | undefined,
  targetLevel: ThinkLevel | undefined,
): boolean {
  if (!targetLevel) {
    return false;
  }
  if (!currentLevel) {
    return true;
  }
  return getThinkingLevelIndex(targetLevel) > getThinkingLevelIndex(currentLevel);
}

function resolveContextUsagePercent(
  totalTokens: number | undefined,
  contextTokens: number | undefined,
): number | undefined {
  if (
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens) ||
    totalTokens <= 0 ||
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0
  ) {
    return undefined;
  }
  return Math.min(100, Math.max(0, (totalTokens / contextTokens) * 100));
}

function findEscalationTarget(
  contextPercent: number,
  thresholds: Array<{ atContextPercent: number; thinking: ThinkLevel }> | undefined,
): ThinkLevel | undefined {
  if (!thresholds || thresholds.length === 0) {
    return undefined;
  }

  // Sort thresholds by atContextPercent descending (highest percentage first)
  const sorted = [...thresholds].toSorted((a, b) => b.atContextPercent - a.atContextPercent);

  // Find the first threshold that's been reached
  for (const threshold of sorted) {
    if (contextPercent >= threshold.atContextPercent) {
      return threshold.thinking;
    }
  }

  return undefined;
}

export async function evaluateAndApplyThinkingEscalation(
  params: ThinkingEscalationParams & {
    updateSessionStoreEntry: UpdateSessionStoreEntryFn;
  },
): Promise<{ didEscalate: boolean; newLevel?: ThinkLevel; previousLevel?: ThinkLevel }> {
  const {
    cfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    contextTokensUsed,
    totalTokens,
    currentThinkLevel,
    updateSessionStoreEntry,
  } = params;

  // Early exit if no session to update
  if (!sessionEntry || !sessionStore || !sessionKey || !storePath) {
    return { didEscalate: false };
  }

  // Check if escalation is enabled
  const escalationConfig = cfg?.agents?.defaults?.thinkingEscalation;
  if (!escalationConfig?.enabled) {
    return { didEscalate: false };
  }

  // Check if we have valid context usage data
  const contextPercent = resolveContextUsagePercent(totalTokens, contextTokensUsed);
  if (typeof contextPercent !== "number") {
    return { didEscalate: false };
  }

  // Find the target thinking level based on current context usage
  const targetLevel = findEscalationTarget(contextPercent, escalationConfig.thresholds);
  if (!targetLevel) {
    return { didEscalate: false };
  }

  // Only escalate, never downgrade
  if (!shouldEscalate(currentThinkLevel, targetLevel)) {
    return { didEscalate: false };
  }

  // Apply the escalation
  const previousLevel = currentThinkLevel;
  sessionEntry.thinkingLevel = targetLevel;
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;

  try {
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async () => ({
        thinkingLevel: targetLevel,
        updatedAt: Date.now(),
      }),
    });
  } catch {
    // Best effort - if persistence fails, the in-memory update still applies
  }

  return { didEscalate: true, newLevel: targetLevel, previousLevel };
}

/**
 * Dreaming Process — Autonomous Memory Consolidation
 *
 * Inspired by how biological brains consolidate memories during sleep,
 * the dreaming process runs during low-activity periods to:
 *
 * 1. Review recent daily memory files (memory/YYYY-MM-DD.md)
 * 2. Extract significant events, decisions, and lessons
 * 3. Consolidate them into long-term memory (MEMORY.md)
 * 4. Prune stale or redundant entries
 * 5. Update the agent's self-model and workspace knowledge
 *
 * This runs as an isolated cron job during configured "sleep" hours
 * (default: 3-5 AM in the agent's timezone) when the user is unlikely
 * to be active. It uses a dedicated low-cost model to minimize expense.
 */

import { createSubsystemLogger } from "../log.js";

const log = createSubsystemLogger("gateway/dreaming");

// ── Types ──────────────────────────────────────────────────────────────

export interface DreamingConfig {
  /** Enable/disable the dreaming process. Default: true */
  enabled: boolean;

  /** Cron expression for when to dream. Default: "0 3 * * *" (3 AM daily) */
  schedule: string;

  /** Timezone for the schedule. Default: agent's configured timezone */
  timezone?: string;

  /** Model to use for dreaming (prefer cheap models). Default: "auto" (cheapest available) */
  model: string;

  /** Maximum number of daily files to review per dream cycle. Default: 7 */
  lookbackDays: number;

  /** Maximum tokens for the dreaming session. Default: 4096 */
  maxTokens: number;

  /**
   * What the dreaming process should do. Default: "consolidate"
   * - "consolidate": Review daily files → update MEMORY.md
   * - "reflect": Consolidate + generate insights about patterns
   * - "organize": Consolidate + reorganize/clean workspace files
   */
  mode: "consolidate" | "reflect" | "organize";

  /** Skip dreaming if there was user activity within this many minutes. Default: 60 */
  quietMinutes: number;

  /** Delivery config for dream reports (optional). */
  delivery?: {
    /** Whether to send a dream summary to the user. Default: false */
    enabled: boolean;
    /** Channel to deliver to. */
    channel?: string;
    /** Recipient. */
    to?: string;
  };
}

// ── Defaults ───────────────────────────────────────────────────────────

export const DREAMING_DEFAULTS: DreamingConfig = {
  enabled: true,
  schedule: "0 3 * * *",
  model: "auto",
  lookbackDays: 7,
  maxTokens: 4096,
  mode: "consolidate",
  quietMinutes: 60,
  delivery: {
    enabled: false,
  },
};

// ── Prompt Generation ──────────────────────────────────────────────────

/**
 * Generates the system prompt for the dreaming agent.
 * This prompt instructs the agent on how to consolidate memories.
 */
export function buildDreamingPrompt(config: DreamingConfig): string {
  const modeInstructions = {
    consolidate: `
## Task: Memory Consolidation

You are in "dreaming" mode — a periodic maintenance process that consolidates recent memories.

### Steps:
1. **Read** the last ${config.lookbackDays} daily memory files from \`memory/\` (newest first)
2. **Read** the current \`MEMORY.md\` long-term memory file
3. **Identify** from the daily files:
   - Important decisions and their reasoning
   - Lessons learned (especially from mistakes)
   - User preferences discovered
   - Project milestones and status changes
   - Relationships and people mentioned
   - Recurring patterns or themes
4. **Update** \`MEMORY.md\` with distilled, organized entries:
   - Add new significant memories
   - Update existing entries if context has changed
   - Remove entries that are no longer relevant or have been superseded
   - Keep it concise — this is curated wisdom, not raw logs
5. **Do NOT delete** daily memory files — they serve as an audit trail

### Guidelines:
- Write in first person (you are the agent reflecting on your experiences)
- Prioritize actionable knowledge over event logging
- Group related memories together
- Include dates for temporal context
- Keep MEMORY.md under 10KB — if it's growing too large, consolidate harder
- If nothing significant happened, that's fine — don't force entries`,

    reflect: `
## Task: Memory Consolidation + Reflection

Perform all consolidation steps (see consolidate mode), plus:

### Additional Reflection Steps:
6. **Analyze patterns** across the last ${config.lookbackDays} days:
   - What topics keep coming up?
   - Are there unresolved issues that keep resurfacing?
   - What's working well? What isn't?
   - Are there efficiency improvements to suggest?
7. **Write a brief reflection** at the top of MEMORY.md under "## Recent Reflections"
   - 2-3 sentences max
   - Should be actionable, not philosophical`,

    organize: `
## Task: Memory Consolidation + Workspace Organization

Perform all consolidation steps (see consolidate mode), plus:

### Additional Organization Steps:
6. **Review workspace files** for staleness:
   - Are there TODO items that have been completed?
   - Are there temporary files that should be cleaned up?
   - Is TOOLS.md still accurate?
   - Is HEARTBEAT.md appropriate?
7. **Update workspace files** as needed
8. **Report** what was organized in your summary`,
  };

  return `# 🌙 Dreaming Process

You are running in an autonomous maintenance mode called "dreaming."
This is NOT a conversation with the user — this is background self-maintenance.

${modeInstructions[config.mode]}

### Output:
After completing your work, provide a brief summary of what changed:
- Memories added/updated/removed
- Any insights discovered
- Any workspace changes made (organize mode only)

Keep the summary under 200 words. This may be delivered to the user as a notification.`;
}

// ── Job Creation ───────────────────────────────────────────────────────

/**
 * Returns the cron job definition for the dreaming process.
 * This is used by the cron service to register the dreaming job.
 */
export function buildDreamingCronJob(config: DreamingConfig, timezone?: string) {
  const tz = config.timezone ?? timezone ?? "UTC";
  const prompt = buildDreamingPrompt(config);

  return {
    name: "🌙 Dreaming — Memory Consolidation",
    schedule: {
      kind: "cron" as const,
      expr: config.schedule,
      tz,
    },
    sessionTarget: "isolated" as const,
    payload: {
      kind: "agentTurn" as const,
      message: prompt,
      model: config.model === "auto" ? undefined : config.model,
      timeoutSeconds: 300,
    },
    delivery: config.delivery?.enabled
      ? {
          mode: "announce" as const,
          channel: config.delivery.channel,
          to: config.delivery.to,
        }
      : { mode: "none" as const },
    enabled: config.enabled,
  };
}

// ── Activity Check ─────────────────────────────────────────────────────

/**
 * Check if the dreaming process should be skipped due to recent user activity.
 * Returns true if it's safe to dream (user has been quiet).
 */
export function shouldDream(lastUserActivityMs: number | undefined, quietMinutes: number): boolean {
  if (lastUserActivityMs === undefined) {
    return true;
  }
  const quietMs = quietMinutes * 60 * 1000;
  const elapsed = Date.now() - lastUserActivityMs;
  if (elapsed < quietMs) {
    log.info(
      `Skipping dream — user active ${Math.round(elapsed / 60000)}m ago (need ${quietMinutes}m quiet)`,
    );
    return false;
  }
  return true;
}

// ── Config Resolution ──────────────────────────────────────────────────

/**
 * Resolve dreaming config from the main OpenClaw config.
 * Falls back to defaults for any unset values.
 */
export function resolveDreamingConfig(raw: Partial<DreamingConfig> | undefined): DreamingConfig {
  if (!raw) {
    return { ...DREAMING_DEFAULTS };
  }
  return {
    enabled: raw.enabled ?? DREAMING_DEFAULTS.enabled,
    schedule: raw.schedule ?? DREAMING_DEFAULTS.schedule,
    timezone: raw.timezone ?? DREAMING_DEFAULTS.timezone,
    model: raw.model ?? DREAMING_DEFAULTS.model,
    lookbackDays: raw.lookbackDays ?? DREAMING_DEFAULTS.lookbackDays,
    maxTokens: raw.maxTokens ?? DREAMING_DEFAULTS.maxTokens,
    mode: raw.mode ?? DREAMING_DEFAULTS.mode,
    quietMinutes: raw.quietMinutes ?? DREAMING_DEFAULTS.quietMinutes,
    delivery: raw.delivery
      ? {
          enabled: raw.delivery.enabled ?? false,
          channel: raw.delivery.channel,
          to: raw.delivery.to,
        }
      : DREAMING_DEFAULTS.delivery,
  };
}

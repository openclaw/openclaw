/**
 * Channel-agnostic status reaction controller.
 * Provides a unified interface for displaying agent status via message reactions.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type StatusReactionAdapter = {
  /** Set/replace the current reaction emoji. */
  setReaction: (emoji: string) => Promise<void>;
  /** Remove a specific reaction emoji (optional — needed for Discord-style platforms). */
  removeReaction?: (emoji: string) => Promise<void>;
};

export type StatusReactionEmojis = {
  queued?: string; // Default: uses initialEmoji param
  thinking?: string; // Default: "🧠"
  tool?: string; // Default: "🛠️"
  coding?: string; // Default: "💻"
  web?: string; // Default: "🌐"
  done?: string; // Default: "✅"
  error?: string; // Default: "❌"
  stallSoft?: string; // Default: "⏳"
  stallHard?: string; // Default: "⚠️"
};

export type StatusReactionTiming = {
  debounceMs?: number; // Default: 700
  stallSoftMs?: number; // Default: 10000
  stallHardMs?: number; // Default: 30000
  doneHoldMs?: number; // Default: 1500 (not used in controller, but exported for callers)
  errorHoldMs?: number; // Default: 2500 (not used in controller, but exported for callers)
};

export type StatusReactionController = {
  setQueued: () => Promise<void> | void;
  setThinking: () => Promise<void> | void;
  setTool: (toolName?: string) => Promise<void> | void;
  setDone: () => Promise<void>;
  setError: () => Promise<void>;
  clear: () => Promise<void>;
  restoreInitial: () => Promise<void>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_EMOJIS: Required<StatusReactionEmojis> = {
  queued: "👀",
  thinking: "🤔",
  tool: "🔥",
  coding: "👨‍💻",
  web: "⚡",
  done: "👍",
  error: "😱",
  stallSoft: "🥱",
  stallHard: "😨",
};

export const DEFAULT_TIMING: Required<StatusReactionTiming> = {
  debounceMs: 700,
  stallSoftMs: 10_000,
  stallHardMs: 30_000,
  doneHoldMs: 1500,
  errorHoldMs: 2500,
};

export const CODING_TOOL_TOKENS: string[] = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "session_status",
  "bash",
];

export const WEB_TOOL_TOKENS: string[] = [
  "web_search",
  "web-search",
  "web_fetch",
  "web-fetch",
  "browser",
];

// ─────────────────────────────────────────────────────────────────────────────
// Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the appropriate emoji for a tool invocation.
 */
export function resolveToolEmoji(
  toolName: string | undefined,
  emojis: Required<StatusReactionEmojis>,
): string {
  const normalized = toolName?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return emojis.tool;
  }
  if (WEB_TOOL_TOKENS.some((token) => normalized.includes(token))) {
    return emojis.web;
  }
  if (CODING_TOOL_TOKENS.some((token) => normalized.includes(token))) {
    return emojis.coding;
  }
  return emojis.tool;
}

/**
 * Create a status reaction controller.
 *
 * Features:
 * - Promise chain serialization (prevents concurrent API calls)
 * - Debouncing (intermediate states debounce, terminal states are immediate)
 * - Stall timers (soft/hard warnings on inactivity)
 * - Terminal state protection (done/error mark finished, subsequent updates ignored)
 */
export function createStatusReactionController(params: {
  enabled: boolean;
  adapter: StatusReactionAdapter;
  initialEmoji: string;
  emojis?: StatusReactionEmojis;
  timing?: StatusReactionTiming;
  onError?: (err: unknown) => void;
}): StatusReactionController {
  const { enabled, adapter, initialEmoji, onError } = params;

  // Merge user-provided overrides with defaults
  const emojis: Required<StatusReactionEmojis> = {
    ...DEFAULT_EMOJIS,
    queued: params.emojis?.queued ?? initialEmoji,
    ...params.emojis,
  };

  const timing: Required<StatusReactionTiming> = {
    ...DEFAULT_TIMING,
    ...params.timing,
  };

  // State
  let currentEmoji = "";
  let pendingEmoji = "";
  let debounceTimer: NodeJS.Timeout | null = null;
  let stallSoftTimer: NodeJS.Timeout | null = null;
  let stallHardTimer: NodeJS.Timeout | null = null;
  let finished = false;
  let chainPromise = Promise.resolve();

  // Known emojis for clear operation
  const knownEmojis = new Set<string>([
    initialEmoji,
    emojis.queued,
    emojis.thinking,
    emojis.tool,
    emojis.coding,
    emojis.web,
    emojis.done,
    emojis.error,
    emojis.stallSoft,
    emojis.stallHard,
  ]);

  /**
   * Serialize async operations to prevent race conditions.
   */
  function enqueue(fn: () => Promise<void>): Promise<void> {
    chainPromise = chainPromise.then(fn, fn);
    return chainPromise;
  }

  /**
   * Clear all timers.
   */
  function clearAllTimers(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (stallSoftTimer) {
      clearTimeout(stallSoftTimer);
      stallSoftTimer = null;
    }
    if (stallHardTimer) {
      clearTimeout(stallHardTimer);
      stallHardTimer = null;
    }
  }

  /**
   * Clear debounce timer only (used during phase transitions).
   */
  function clearDebounceTimer(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  /**
   * Reset stall timers (called on each phase change).
   */
  function resetStallTimers(): void {
    if (stallSoftTimer) {
      clearTimeout(stallSoftTimer);
    }
    if (stallHardTimer) {
      clearTimeout(stallHardTimer);
    }

    stallSoftTimer = setTimeout(() => {
      scheduleEmoji(emojis.stallSoft, { immediate: true, skipStallReset: true });
    }, timing.stallSoftMs);

    stallHardTimer = setTimeout(() => {
      scheduleEmoji(emojis.stallHard, { immediate: true, skipStallReset: true });
    }, timing.stallHardMs);
  }

  /**
   * Apply an emoji: set new reaction and optionally remove old one.
   */
  async function applyEmoji(newEmoji: string): Promise<void> {
    if (!enabled) {
      return;
    }

    try {
      const previousEmoji = currentEmoji;
      await adapter.setReaction(newEmoji);

      // If adapter supports removeReaction and there's a different previous emoji, remove it
      if (adapter.removeReaction && previousEmoji && previousEmoji !== newEmoji) {
        await adapter.removeReaction(previousEmoji);
      }

      currentEmoji = newEmoji;
    } catch (err) {
      if (onError) {
        onError(err);
      }
    }
  }

  /**
   * Schedule an emoji change (debounced or immediate).
   */
  function scheduleEmoji(
    emoji: string,
    options: { immediate?: boolean; skipStallReset?: boolean } = {},
  ): void {
    if (!enabled || finished) {
      return;
    }

    // Deduplicate: if already scheduled/current, skip send but keep stall timers fresh
    if (emoji === currentEmoji || emoji === pendingEmoji) {
      if (!options.skipStallReset) {
        resetStallTimers();
      }
      return;
    }

    pendingEmoji = emoji;
    clearDebounceTimer();

    if (options.immediate) {
      // Immediate execution for terminal states
      void enqueue(async () => {
        await applyEmoji(emoji);
        pendingEmoji = "";
      });
    } else {
      // Debounced execution for intermediate states
      debounceTimer = setTimeout(() => {
        void enqueue(async () => {
          await applyEmoji(emoji);
          pendingEmoji = "";
        });
      }, timing.debounceMs);
    }

    // Reset stall timers on phase change (unless triggered by stall timer itself)
    if (!options.skipStallReset) {
      resetStallTimers();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Controller API
  // ───────────────────────────────────────────────────────────────────────────

  function setQueued(): void {
    scheduleEmoji(emojis.queued, { immediate: true });
  }

  function setThinking(): void {
    scheduleEmoji(emojis.thinking);
  }

  function setTool(toolName?: string): void {
    const emoji = resolveToolEmoji(toolName, emojis);
    scheduleEmoji(emoji);
  }

  function setDone(): Promise<void> {
    if (!enabled) {
      return Promise.resolve();
    }

    finished = true;
    clearAllTimers();

    // Directly enqueue to ensure we return the updated promise
    return enqueue(async () => {
      await applyEmoji(emojis.done);
      pendingEmoji = "";
    });
  }

  function setError(): Promise<void> {
    if (!enabled) {
      return Promise.resolve();
    }

    finished = true;
    clearAllTimers();

    // Directly enqueue to ensure we return the updated promise
    return enqueue(async () => {
      await applyEmoji(emojis.error);
      pendingEmoji = "";
    });
  }

  async function clear(): Promise<void> {
    if (!enabled) {
      return;
    }

    clearAllTimers();
    finished = true;

    await enqueue(async () => {
      if (adapter.removeReaction) {
        // Remove all known emojis (Discord-style)
        const emojisToRemove = Array.from(knownEmojis);
        for (const emoji of emojisToRemove) {
          try {
            await adapter.removeReaction(emoji);
          } catch (err) {
            if (onError) {
              onError(err);
            }
          }
        }
      } else {
        // For platforms without removeReaction, set empty or just skip
        // (Telegram handles this atomically on the next setReaction)
      }
      currentEmoji = "";
      pendingEmoji = "";
    });
  }

  async function restoreInitial(): Promise<void> {
    if (!enabled) {
      return;
    }

    clearAllTimers();
    await enqueue(async () => {
      await applyEmoji(initialEmoji);
      pendingEmoji = "";
    });
  }

  return {
    setQueued,
    setThinking,
    setTool,
    setDone,
    setError,
    clear,
    restoreInitial,
  };
}

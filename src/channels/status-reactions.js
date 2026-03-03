/**
 * Channel-agnostic status reaction controller.
 * Provides a unified interface for displaying agent status via message reactions.
 */
// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_EMOJIS = {
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
export const DEFAULT_TIMING = {
    debounceMs: 700,
    stallSoftMs: 10000,
    stallHardMs: 30000,
    doneHoldMs: 1500,
    errorHoldMs: 2500,
};
export const CODING_TOOL_TOKENS = [
    "exec",
    "process",
    "read",
    "write",
    "edit",
    "session_status",
    "bash",
];
export const WEB_TOOL_TOKENS = [
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
export function resolveToolEmoji(toolName, emojis) {
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
export function createStatusReactionController(params) {
    const { enabled, adapter, initialEmoji, onError } = params;
    // Merge user-provided overrides with defaults
    const emojis = {
        ...DEFAULT_EMOJIS,
        queued: params.emojis?.queued ?? initialEmoji,
        ...params.emojis,
    };
    const timing = {
        ...DEFAULT_TIMING,
        ...params.timing,
    };
    // State
    let currentEmoji = "";
    let pendingEmoji = "";
    let debounceTimer = null;
    let stallSoftTimer = null;
    let stallHardTimer = null;
    let finished = false;
    let chainPromise = Promise.resolve();
    // Known emojis for clear operation
    const knownEmojis = new Set([
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
    function enqueue(fn) {
        chainPromise = chainPromise.then(fn, fn);
        return chainPromise;
    }
    /**
     * Clear all timers.
     */
    function clearAllTimers() {
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
    function clearDebounceTimer() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    }
    /**
     * Reset stall timers (called on each phase change).
     */
    function resetStallTimers() {
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
    async function applyEmoji(newEmoji) {
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
        }
        catch (err) {
            if (onError) {
                onError(err);
            }
        }
    }
    /**
     * Schedule an emoji change (debounced or immediate).
     */
    function scheduleEmoji(emoji, options = {}) {
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
        }
        else {
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
    function setQueued() {
        scheduleEmoji(emojis.queued, { immediate: true });
    }
    function setThinking() {
        scheduleEmoji(emojis.thinking);
    }
    function setTool(toolName) {
        const emoji = resolveToolEmoji(toolName, emojis);
        scheduleEmoji(emoji);
    }
    function finishWithEmoji(emoji) {
        if (!enabled) {
            return Promise.resolve();
        }
        finished = true;
        clearAllTimers();
        // Directly enqueue to ensure we return the updated promise
        return enqueue(async () => {
            await applyEmoji(emoji);
            pendingEmoji = "";
        });
    }
    function setDone() {
        return finishWithEmoji(emojis.done);
    }
    function setError() {
        return finishWithEmoji(emojis.error);
    }
    async function clear() {
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
                    }
                    catch (err) {
                        if (onError) {
                            onError(err);
                        }
                    }
                }
            }
            else {
                // For platforms without removeReaction, set empty or just skip
                // (Telegram handles this atomically on the next setReaction)
            }
            currentEmoji = "";
            pendingEmoji = "";
        });
    }
    async function restoreInitial() {
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

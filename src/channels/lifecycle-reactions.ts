import type { LifecycleReactionsConfig } from "../config/types.messages.js";

/**
 * Message processing lifecycle stages.
 * Stages progress: received → queued → processing → complete
 */
export type LifecycleStage = "received" | "queued" | "processing" | "complete";

/**
 * Channel-specific reaction operations.
 * Each channel adapter provides these callbacks to handle actual API calls.
 */
export type LifecycleReactionAdapter = {
  /** Add a reaction emoji to the message. Returns true if successful. */
  addReaction: (emoji: string) => Promise<boolean>;
  /** Remove a reaction emoji from the message. */
  removeReaction: (emoji: string) => Promise<void>;
  /** Called when errors occur (for logging). */
  onError?: (stage: LifecycleStage, action: "add" | "remove", error: unknown) => void;
};

/**
 * State tracker for a single message's lifecycle reactions.
 */
export type LifecycleReactionState = {
  /** Currently active reaction emoji (if any). */
  currentEmoji: string | null;
  /** Current lifecycle stage. */
  currentStage: LifecycleStage | null;
  /** Promise tracking the current reaction operation. */
  pendingOperation: Promise<boolean> | null;
};

/**
 * Create initial lifecycle state.
 */
export function createLifecycleState(): LifecycleReactionState {
  return {
    currentEmoji: null,
    currentStage: null,
    pendingOperation: null,
  };
}

/**
 * Get the emoji for a given lifecycle stage.
 * Falls back to ackReaction for "received" if not explicitly set.
 */
export function getLifecycleEmoji(
  config: LifecycleReactionsConfig | undefined,
  stage: LifecycleStage,
  fallbackAckReaction?: string,
): string | null {
  if (!config) {
    // No lifecycle config - use ackReaction for received only
    if (stage === "received" && fallbackAckReaction) {
      return fallbackAckReaction;
    }
    return null;
  }

  const emoji = config[stage];
  if (emoji) {
    return emoji;
  }

  // For received stage, fall back to ackReaction if not explicitly set
  if (stage === "received" && fallbackAckReaction) {
    return fallbackAckReaction;
  }

  return null;
}

/**
 * Check if lifecycle reactions are enabled (config exists and at least one stage has an emoji).
 * Note: fallbackAckReaction is only used as a fallback for the "received" stage emoji,
 * not as a signal that lifecycle is enabled. Lifecycle requires explicit config.
 */
export function isLifecycleEnabled(
  config: LifecycleReactionsConfig | undefined,
  _fallbackAckReaction?: string,
): boolean {
  if (!config) {
    return false;
  }
  return !!(config.received || config.queued || config.processing || config.complete);
}

/**
 * Transition to a new lifecycle stage.
 * Handles removing the previous reaction (if different) and adding the new one.
 *
 * @returns Promise that resolves to true if the new reaction was added successfully.
 */
export async function transitionLifecycleStage(params: {
  state: LifecycleReactionState;
  config: LifecycleReactionsConfig | undefined;
  stage: LifecycleStage;
  adapter: LifecycleReactionAdapter;
  fallbackAckReaction?: string;
}): Promise<boolean> {
  const { state, config, stage, adapter, fallbackAckReaction } = params;

  // Wait for any pending operation to complete
  if (state.pendingOperation) {
    try {
      await state.pendingOperation;
    } catch {
      // Ignore errors from previous operations
    }
  }

  const newEmoji = getLifecycleEmoji(config, stage, fallbackAckReaction);
  const oldEmoji = state.currentEmoji;

  // No change needed if emojis are the same
  if (newEmoji === oldEmoji) {
    state.currentStage = stage;
    return !!newEmoji;
  }

  // Create the transition operation
  const operation = (async () => {
    // Remove old emoji if present and different
    if (oldEmoji && oldEmoji !== newEmoji) {
      try {
        await adapter.removeReaction(oldEmoji);
        // Clear state after successful removal
        state.currentEmoji = null;
      } catch (err) {
        adapter.onError?.(stage, "remove", err);
        // Continue even if removal fails, but don't clear state
      }
    }

    // Add new emoji if present
    if (newEmoji) {
      try {
        const added = await adapter.addReaction(newEmoji);
        if (added) {
          state.currentEmoji = newEmoji;
          state.currentStage = stage;
          return true;
        }
      } catch (err) {
        adapter.onError?.(stage, "add", err);
      }
      // Failed to add - state.currentEmoji already cleared above or stays null
      state.currentStage = stage;
      return false;
    }

    // No new emoji to add
    state.currentEmoji = null;
    state.currentStage = stage;
    return false;
  })();

  state.pendingOperation = operation;

  try {
    return await operation;
  } finally {
    // Clear pending operation if it's still this one
    if (state.pendingOperation === operation) {
      state.pendingOperation = null;
    }
  }
}

/**
 * Clear all lifecycle reactions (remove current emoji).
 * Use this when you want to clean up without transitioning to a stage.
 */
export async function clearLifecycleReaction(params: {
  state: LifecycleReactionState;
  adapter: LifecycleReactionAdapter;
}): Promise<void> {
  const { state, adapter } = params;

  // Wait for pending operation
  if (state.pendingOperation) {
    try {
      await state.pendingOperation;
    } catch {
      // Ignore
    }
  }

  if (state.currentEmoji) {
    try {
      await adapter.removeReaction(state.currentEmoji);
    } catch (err) {
      adapter.onError?.(state.currentStage ?? "received", "remove", err);
    }
    state.currentEmoji = null;
  }

  state.currentStage = null;
  state.pendingOperation = null;
}

/**
 * Helper to create a lifecycle manager for a specific message.
 * Bundles state and adapter together for convenient usage.
 */
export function createLifecycleManager(params: {
  config: LifecycleReactionsConfig | undefined;
  adapter: LifecycleReactionAdapter;
  fallbackAckReaction?: string;
}) {
  const state = createLifecycleState();
  const { config, adapter, fallbackAckReaction } = params;

  return {
    state,

    /** Transition to received stage (message arrived). */
    received: () =>
      transitionLifecycleStage({
        state,
        config,
        stage: "received",
        adapter,
        fallbackAckReaction,
      }),

    /** Transition to queued stage (waiting for processing slot). */
    queued: () =>
      transitionLifecycleStage({
        state,
        config,
        stage: "queued",
        adapter,
        fallbackAckReaction,
      }),

    /** Transition to processing stage (model generating response). */
    processing: () =>
      transitionLifecycleStage({
        state,
        config,
        stage: "processing",
        adapter,
        fallbackAckReaction,
      }),

    /** Transition to complete stage (response done). */
    complete: () =>
      transitionLifecycleStage({
        state,
        config,
        stage: "complete",
        adapter,
        fallbackAckReaction,
      }),

    /** Clear all reactions. */
    clear: () => clearLifecycleReaction({ state, adapter }),

    /** Get current stage. */
    getCurrentStage: () => state.currentStage,

    /** Get current emoji. */
    getCurrentEmoji: () => state.currentEmoji,
  };
}

import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";

/**
 * Post-compaction recovery prompt injected into the next user message after
 * auto-compaction completes. Instructs the agent to recall task state from
 * memory and notify the user about the context reset.
 *
 * Kept under 200 tokens to minimize context overhead.
 */
export const POST_COMPACTION_RECOVERY_PROMPT = [
  "[Post-compaction recovery — mandatory steps]",
  "Context was just compacted. Before responding, you MUST:",
  '1. Run memory_recall("active task") to check for saved task state.',
  "2. Read TASKS.md if it exists in your workspace.",
  "3. Compare recovered state against the compaction summary above.",
  '4. Notify the user: "🔄 Context Reset — last task: [X], resuming from step [Y]" (or summarize what you recall).',
  "Do NOT skip these steps. Proceed with the user's message after recovery.",
].join("\n");

/**
 * Check whether the session needs post-compaction recovery and return the
 * recovery prompt if so. Returns `null` when no recovery is needed.
 */
export function getPostCompactionRecoveryPrompt(entry?: SessionEntry): string | null {
  if (!entry?.needsPostCompactionRecovery) {
    return null;
  }
  return POST_COMPACTION_RECOVERY_PROMPT;
}

/**
 * Prepend the post-compaction recovery prompt to the user's message body.
 * Returns the original body unchanged if no recovery is needed.
 */
export function prependPostCompactionRecovery(body: string, entry?: SessionEntry): string {
  const prompt = getPostCompactionRecoveryPrompt(entry);
  if (!prompt) {
    return body;
  }
  return `${prompt}\n\n${body}`;
}

/**
 * Set or clear the post-compaction recovery flag on a session.
 */
async function setPostCompactionRecovery(
  value: boolean,
  params: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
  },
): Promise<void> {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  if (!sessionStore || !sessionKey) {
    return;
  }
  const entry = sessionStore[sessionKey] ?? sessionEntry;
  if (!entry) {
    return;
  }
  sessionStore[sessionKey] = {
    ...entry,
    needsPostCompactionRecovery: value,
  };
  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      if (store[sessionKey]) {
        store[sessionKey] = {
          ...store[sessionKey],
          needsPostCompactionRecovery: value,
        };
      }
    });
  }
}

/**
 * Mark a session as needing post-compaction recovery on the next turn.
 */
export async function markNeedsPostCompactionRecovery(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<void> {
  return setPostCompactionRecovery(true, params);
}

/**
 * Clear the post-compaction recovery flag after recovery instructions have
 * been injected into the prompt.
 */
export async function clearPostCompactionRecovery(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<void> {
  return setPostCompactionRecovery(false, params);
}

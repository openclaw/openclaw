// Bounded transcript snapshot delivered to `before_reset` plugin hooks.
import { readSessionTranscriptHookMessages } from "../config/sessions/session-accessor.sqlite-hook-messages.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { logVerbose } from "../globals.js";
import { boundedParsedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { readSessionMessagesPageWithStatsAsync } from "./session-transcript-readers.js";

/**
 * Newest messages handed to `before_reset` observers. Mirrors the bounded
 * session-memory capture so a reset never materializes an unbounded history:
 * a 1.6M-message session previously took ~118 s and ~15 GiB of heap to build
 * this payload, freezing the Gateway on every `/new`.
 */
const BEFORE_RESET_HOOK_MAX_MESSAGES = 4_096;
const BEFORE_RESET_HOOK_MAX_BYTES = 8 * 1024 * 1024;

export type BeforeResetHookMessages = {
  /** Newest transcript messages, oldest first, bounded by count and bytes. */
  messages: unknown[];
  /** Message count before bounding, omitted when bounded classification cannot establish it. */
  totalMessages?: number;
  /** True when history was omitted or bounded classification could not establish completeness. */
  truncated: boolean;
};

function emptyBeforeResetHookMessages(): BeforeResetHookMessages {
  return { messages: [], totalMessages: 0, truncated: false };
}

export type BeforeResetHookMessagesScope = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  sessionEntry?: Partial<Pick<SessionEntry, "sessionId">>;
};

/**
 * Reads the pre-reset transcript for plugin observers without loading the
 * whole session. Missing identity or read failures fire the hook with an
 * empty payload, matching the previous contract.
 */
export async function readBeforeResetHookMessages(
  scope: BeforeResetHookMessagesScope,
  selection: "display" | "raw" = "display",
): Promise<BeforeResetHookMessages> {
  const sessionId = typeof scope.sessionId === "string" ? scope.sessionId.trim() : "";
  const sessionKey = typeof scope.sessionKey === "string" ? scope.sessionKey.trim() : "";
  const storePath = typeof scope.storePath === "string" ? scope.storePath.trim() : "";
  if (!sessionId || !sessionKey || !storePath) {
    logVerbose("before_reset: no session identity available, firing hook with empty messages");
    return emptyBeforeResetHookMessages();
  }
  try {
    const target = {
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      ...(scope.sessionEntry ? { sessionEntry: scope.sessionEntry } : {}),
      sessionId,
      sessionKey,
      storePath,
    };
    const limits = {
      maxMessages: BEFORE_RESET_HOOK_MAX_MESSAGES,
      maxBytes: BEFORE_RESET_HOOK_MAX_BYTES,
    };
    const result: { messages: unknown[]; totalMessages?: number; truncated?: boolean } =
      selection === "raw"
        ? await readSessionTranscriptHookMessages(target, limits)
        : await readSessionMessagesPageWithStatsAsync(target, { ...limits, offset: 0 });
    // Projection metadata can enlarge display messages. Bound the public array
    // too, after the storage reader has enforced its pre-hydration byte ceiling.
    let bytes = 2;
    let start = result.messages.length;
    for (let index = result.messages.length - 1; index >= 0; index -= 1) {
      // Measure an array slot so omitted values have JSON array semantics too.
      const measured = boundedParsedJsonUtf8Bytes(
        [result.messages[index]],
        BEFORE_RESET_HOOK_MAX_BYTES - bytes + 1,
      );
      if (!measured.complete) {
        break;
      }
      bytes += measured.bytes - 2 + 1;
      start = index;
    }
    const messages = result.messages.slice(start);
    const totalMessages =
      result.totalMessages === undefined
        ? undefined
        : Math.max(result.totalMessages, result.messages.length);
    return {
      messages,
      ...(totalMessages !== undefined ? { totalMessages } : {}),
      truncated:
        result.truncated === true ||
        start > 0 ||
        (totalMessages !== undefined && totalMessages > messages.length),
    };
  } catch (err: unknown) {
    logVerbose(
      `before_reset: failed to read session messages for ${sessionKey}/${sessionId}; firing hook with empty messages (${String(err)})`,
    );
    return emptyBeforeResetHookMessages();
  }
}

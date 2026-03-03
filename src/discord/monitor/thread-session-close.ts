import { listAgentIds } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStorePath, updateSessionStore } from "../../config/sessions.js";

/**
 * Marks every session entry in the store whose key contains {@link threadId}
 * as "reset" by setting `updatedAt` to 0.
 *
 * This mirrors how the daily / idle session reset works: zeroing `updatedAt`
 * makes `evaluateSessionFreshness` treat the session as stale on the next
 * inbound message, so the bot starts a fresh conversation without deleting
 * any on-disk transcript history.
 */
export async function closeDiscordThreadSessions(params: {
  cfg: OpenClawConfig;
  accountId: string;
  threadId: string;
}): Promise<number> {
  const { cfg, accountId, threadId } = params;

  const normalizedThreadId = threadId.trim().toLowerCase();
  if (!normalizedThreadId) {
    return 0;
  }

  // Match when the threadId appears as a complete colon-separated segment.
  // e.g. "999" must be followed by ":" (middle) or end-of-string (final).
  // Using a regex avoids false-positives where one snowflake is a prefix of
  // another (e.g. searching for "999" must not match ":99900").
  //
  // Session key shapes:
  //   agent:<agentId>:discord:channel:<threadId>
  //   agent:<agentId>:discord:channel:<parentId>:thread:<threadId>
  const segmentRe = new RegExp(`:${normalizedThreadId}(?::|$)`, "i");

  function sessionKeyContainsThreadId(key: string): boolean {
    return segmentRe.test(key);
  }

  let resetCount = 0;
  const candidateAgentIds = new Set<string>([...listAgentIds(cfg), accountId]);
  const seenStorePaths = new Set<string>();

  for (const agentId of candidateAgentIds) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    if (seenStorePaths.has(storePath)) {
      continue;
    }
    seenStorePaths.add(storePath);

    await updateSessionStore(storePath, (store) => {
      for (const [key, entry] of Object.entries(store)) {
        if (!entry || !sessionKeyContainsThreadId(key)) {
          continue;
        }
        // Setting updatedAt to 0 signals that this session is stale.
        // evaluateSessionFreshness will create a new session on the next message.
        entry.updatedAt = 0;
        resetCount += 1;
      }
      return resetCount;
    });
  }

  return resetCount;
}

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
 *
 * @param params.cfg       - Loaded OpenClaw config (used to resolve the store path).
 * @param params.accountId - Discord account ID (bot token identity). Used to
 *                           resolve an agent-specific store when `cfg.session.store`
 *                           contains an `{agentId}` placeholder.
 * @param params.threadId  - Discord thread channel ID (snowflake string). Every
 *                           session key that contains this ID as a colon-delimited
 *                           segment will be reset.
 *
 * @returns The number of sessions that were reset.
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

  // Resolve the store file. We pass `accountId` as `agentId` here to mirror
  // how other Discord subsystems (e.g. message-handler, telegram/bot.ts)
  // resolve their per-account sessions stores.
  const storePath = resolveStorePath(cfg.session?.store, { agentId: accountId });

  let resetCount = 0;

  await updateSessionStore(storePath, (store) => {
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || !sessionKeyContainsThreadId(key)) {
        continue;
      }
      // Setting updatedAt to 0 signals that this session is stale.
      // evaluateSessionFreshness will create a new session on the next message.
      entry.updatedAt = 0;
      resetCount++;
    }
    return resetCount;
  });

  return resetCount;
}

// Compaction notifier hook sends notifications when session compaction occurs.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { HookHandler } from "../../hooks.js";

/** Read optional numeric compaction metadata without trusting hook context shape. */
function readOptionalNumber(context: Record<string, unknown>, key: string): number | undefined {
  const value = context[key];
  return asFiniteNumber(value);
}

/** True when internal after-hooks mark a native skip (not a zero message-count delta). */
function isSkippedCompactionOutcome(context: Record<string, unknown>): boolean {
  return context.compactionOutcome === "skipped";
}

/** Session compaction hook that emits short user-visible progress messages. */
const handler: HookHandler = async (event) => {
  try {
    const context = event.context;

    if (event.type === "session" && event.action === "compact:before") {
      const messageCount = readOptionalNumber(context, "messageCount");
      const messageSuffix =
        messageCount !== undefined && messageCount >= 0 ? ` (${messageCount} messages)` : "";
      event.messages.push(
        `🧹 Compacting context${messageSuffix} so I can continue without losing history…`,
      );
      return;
    }

    if (event.type === "session" && event.action === "compact:after") {
      // Native skip completion sets compactionOutcome: "skipped". compactedCount: 0 alone can
      // also mean a successful provider rewrite that did not shorten session.messages.
      if (isSkippedCompactionOutcome(context)) {
        event.messages.push("✅ Nothing to compact. Continuing from where I left off.");
        return;
      }
      const tokensBefore = readOptionalNumber(context, "tokensBefore");
      const tokensAfter = readOptionalNumber(context, "tokensAfter");
      const tokenDelta =
        tokensBefore !== undefined && tokensAfter !== undefined
          ? ` (${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens)`
          : "";
      event.messages.push(`✅ Context compacted${tokenDelta}. Continuing from where I left off.`);
    }
  } catch (error) {
    console.warn(
      `[compaction-notifier] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export default handler;

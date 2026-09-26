// Compaction notifier hook sends notifications when session compaction occurs.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { HookHandler } from "../../hooks.js";

/** Session compaction hook that emits short user-visible progress messages. */
const handler: HookHandler = async (event) => {
  try {
    const context = event.context;

    if (event.type === "session" && event.action === "compact:before") {
      const messageCount = asFiniteNumber(context.messageCount);
      const messageSuffix =
        messageCount !== undefined && messageCount >= 0 ? ` (${messageCount} messages)` : "";
      event.messages.push(
        `🧹 Compacting context${messageSuffix} so I can continue without losing history…`,
      );
      return;
    }

    if (event.type === "session" && event.action === "compact:after") {
      const tokensBefore = asFiniteNumber(context.tokensBefore);
      const tokensAfter = asFiniteNumber(context.tokensAfter);
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

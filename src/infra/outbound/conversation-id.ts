// Conversation id helpers derive stable outbound conversation keys from
// explicit thread ids or safe channel/group target shapes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";

/**
 * Chooses the best conversation id from an explicit thread id or outbound targets.
 */
export function resolveConversationIdFromTargets(params: {
  threadId?: string | number;
  targets: Array<string | undefined | null>;
}): string | undefined {
  const threadId = stringifyRouteThreadId(params.threadId);
  if (threadId) {
    return threadId;
  }

  for (const rawTarget of params.targets) {
    const target = normalizeOptionalString(rawTarget);
    if (!target) {
      continue;
    }
    const lowered = target.toLowerCase();
    const prefix = ["channel:", "conversation:", "group:", "room:", "dm:"].find((candidate) =>
      lowered.startsWith(candidate),
    );
    const explicitConversationId = prefix
      ? normalizeOptionalString(target.slice(prefix.length))
      : undefined;
    if (explicitConversationId) {
      return explicitConversationId;
    }
    if (target.includes(":")) {
      // Colon targets are usually provider-native ids. Only explicit target
      // prefixes above are safe to collapse into a portable conversation id.
      continue;
    }
    const mentionMatch = target.match(/^<#(\d+)>$/);
    if (mentionMatch?.[1]) {
      return mentionMatch[1];
    }
    if (/^\d{6,}$/.test(target)) {
      return target;
    }
  }

  return undefined;
}

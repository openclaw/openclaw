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
    const explicitConversationId = normalizeOptionalString(
      /^(?:channel|conversation|group|room|dm):(.*)$/is.exec(target)?.[1],
    );
    if (explicitConversationId) {
      return explicitConversationId;
    }
    if (target.includes(":")) {
      // Colon targets are usually provider-native ids. Only explicit target
      // prefixes above are safe to collapse into a portable conversation id.
      continue;
    }
    const numericIdMatch = /^(?:<#(\d+)>|(\d{6,}))$/.exec(target);
    if (numericIdMatch) {
      return numericIdMatch[1] ?? numericIdMatch[2];
    }
  }

  return undefined;
}

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function resolveConversationIdFromTargets(
  targets: Array<string | undefined | null>,
): string | undefined {
  for (const rawTarget of targets) {
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

import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { buildBuiltinChatCommands } from "./commands-registry.shared.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";
import { listThinkingLevels } from "./thinking.js";

let cachedCommands: ChatCommandDefinition[] | null = null;

/** Returns the built-in command registry with runtime thinking-level choices. */
export function getChatCommands(): ChatCommandDefinition[] {
  return (cachedCommands ??= buildBuiltinChatCommands({ listThinkingLevels }));
}

/** Lists slash command names reserved by built-in chat commands and callers. */
export function listReservedChatSlashCommandNames(extraNames: string[] = []): Set<string> {
  const reserved = new Set<string>();
  for (const command of getChatCommands()) {
    if (command.nativeName) {
      reserved.add(command.nativeName);
    }
    for (const alias of command.textAliases) {
      reserved.add(alias.slice(1));
    }
  }
  for (const name of extraNames) {
    const trimmed = normalizeOptionalLowercaseString(name);
    if (trimmed) {
      reserved.add(trimmed);
    }
  }
  return reserved;
}

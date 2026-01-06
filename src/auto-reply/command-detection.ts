import { listChatCommands } from "./commands-registry.js";

export function hasControlCommand(text?: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const lowered = trimmed.toLowerCase();
  for (const command of listChatCommands()) {
    for (const alias of command.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) continue;
      if (lowered === normalized) return true;
      if (command.acceptsArgs && lowered.startsWith(normalized)) {
        const nextChar = trimmed.charAt(normalized.length);
        if (nextChar && /\s/.test(nextChar)) return true;
      }
    }
  }
  return false;
}

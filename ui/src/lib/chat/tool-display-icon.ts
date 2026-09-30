import SHARED_TOOL_DISPLAY_JSON from "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import type { IconName } from "../../components/icons.ts";

const TOOL_ICON_MAP = new Map<string, IconName>([
  ["exec", "squareTerminal"],
  ["bash", "squareTerminal"],
  ["shell", "squareTerminal"],
  ["terminal", "squareTerminal"],
  ["process", "squareTerminal"],
  ["gateway_process", "squareTerminal"],
  ["search", "search"],
  ["grep", "search"],
  ["find", "search"],
  ["glob", "search"],
  ["web_search", "search"],
  ["memory_search", "search"],
  ["sessions_search", "search"],
]);

const EMOJI_ICON_MAP: Record<string, IconName> = {
  "🧩": "puzzle",
  "🛠️": "wrench",
  "🧰": "wrench",
  "📖": "fileText",
  "✍️": "edit",
  "📝": "penLine",
  "📎": "paperclip",
  "🌐": "globe",
  "📺": "monitor",
  "🧾": "fileText",
  "🔐": "settings",
  "💻": "monitor",
  "🔌": "plug",
  "💬": "messageSquare",
};

export function resolveToolDisplayIcon(name: string): IconName {
  const key = name.trim().toLowerCase();
  const namedIcon = TOOL_ICON_MAP.get(key);
  if (namedIcon) {
    return namedIcon;
  }
  const tools: Record<string, { emoji?: string }> = SHARED_TOOL_DISPLAY_JSON.tools;
  const spec = tools[key] ?? SHARED_TOOL_DISPLAY_JSON.fallback;
  return EMOJI_ICON_MAP[spec.emoji ?? ""] ?? "puzzle";
}

import { TOOL_DISPLAY_CONFIG } from "../../../../src/agents/tool-display-config.js";
import { iconData, type IconName } from "../../components/icon-data.ts";

const tools = new Map<string, { icon: string }>(Object.entries(TOOL_DISPLAY_CONFIG.tools));

// Chat keeps these semantic glyphs when no tool or plugin artwork is available.
const CHAT_TOOL_ICONS = new Map<string, IconName>([
  ["decision_evaluate", "scale"],
  ["sessions_create", "messageSquarePlus"],
  ["sessions_history", "messageSquare"],
  ["conversations_turn", "messageSquare"],
  ["github_identity_status", "github"],
  ["session_project", "folder"],
  ["sessions_yield", "clock"],
  ["suggest_task", "listTodo"],
  ["dismiss_task", "listTodo"],
  ["agents_list", "bot"],
  ["skill_workshop", "book"],
  ["tool_search", "search"],
  ["tool_describe", "book"],
  ["codex_threads", "squareTerminal"],
  ["codex_plugins", "squareTerminal"],
  ["codex_endpoint_probe", "squareTerminal"],
  ["codex_sessions_list", "squareTerminal"],
  ["codex_session_read", "squareTerminal"],
  ["codex_session_send", "squareTerminal"],
  ["codex_session_interrupt", "squareTerminal"],
  ["toolsearch", "search"],
]);

// Foreign tool previews and generic rows can lack the arguments needed for row-kind icons.
const TOOL_NAME_ALIASES = new Map([
  ["shell", "exec"],
  ["search", "web_search"],
  ["grep", "web_search"],
  ["find", "web_search"],
  ["glob", "web_search"],
]);

function isIconName(name: string): name is IconName {
  return Object.hasOwn(iconData, name);
}

export function resolveToolDisplayIcon(name: string): IconName {
  const key = name.trim().toLowerCase();
  const chatIcon = CHAT_TOOL_ICONS.get(key);
  if (chatIcon) {
    return chatIcon;
  }
  const spec =
    tools.get(key) ?? tools.get(TOOL_NAME_ALIASES.get(key) ?? "") ?? TOOL_DISPLAY_CONFIG.fallback;
  return isIconName(spec.icon) ? spec.icon : "puzzle";
}

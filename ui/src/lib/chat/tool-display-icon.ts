import { TOOL_DISPLAY_BASE } from "../../../../src/agents/tool-display-config.js";
import { iconData, type IconName } from "../../components/icon-data.ts";

const tools = new Map<string, { icon: string }>(Object.entries(TOOL_DISPLAY_BASE.tools));

const CHAT_TOOL_ICONS = new Map<string, IconName>([
  ["tool_search", "search"],
  ["toolsearch", "search"],
  ["tool_describe", "book"],
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
    tools.get(key) ?? tools.get(TOOL_NAME_ALIASES.get(key) ?? "") ?? TOOL_DISPLAY_BASE.fallback;
  return isIconName(spec.icon) ? spec.icon : "puzzle";
}

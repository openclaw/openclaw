import SHARED_TOOL_DISPLAY_JSON from "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import { icons, type IconName } from "../../components/icons.ts";

const tools = new Map<string, { icon: string }>(Object.entries(SHARED_TOOL_DISPLAY_JSON.tools));

// Foreign tool previews and generic rows can lack the arguments needed for row-kind icons.
const TOOL_NAME_ALIASES = new Map([
  ["shell", "exec"],
  ["search", "web_search"],
  ["grep", "web_search"],
  ["find", "web_search"],
  ["glob", "web_search"],
]);

function isIconName(name: string): name is IconName {
  return Object.hasOwn(icons, name);
}

export function resolveToolDisplayIcon(name: string): IconName {
  const key = name.trim().toLowerCase();
  const spec =
    tools.get(key) ??
    tools.get(TOOL_NAME_ALIASES.get(key) ?? "") ??
    SHARED_TOOL_DISPLAY_JSON.fallback;
  return isIconName(spec.icon) ? spec.icon : "puzzle";
}

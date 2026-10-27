import SHARED_TOOL_DISPLAY_JSON from "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import type { ToolDisplaySpec } from "../../../../src/agents/tool-display-common.js";
import {
  defaultTitle,
  normalizeToolDisplayName,
} from "../../../../src/agents/tool-display-name.js";
import { resolveToolDisplayIcon } from "./tool-display-icon.ts";

const TOOL_MAP: Record<string, ToolDisplaySpec> = SHARED_TOOL_DISPLAY_JSON.tools;

/** Labels and icons do not need the argument-detail parsers. */
export function resolveToolDisplayIdentity(toolName?: string) {
  const name = normalizeToolDisplayName(toolName);
  const spec = TOOL_MAP[name.toLowerCase()];
  return {
    name,
    label: spec?.label ?? spec?.title ?? defaultTitle(name),
    icon: resolveToolDisplayIcon(name),
  };
}

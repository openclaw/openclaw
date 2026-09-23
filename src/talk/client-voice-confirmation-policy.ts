import { createHash } from "node:crypto";
import { buildToolMutationState } from "../agents/tool-mutation.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";

export function stableToolFingerprint(toolName: string, params: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  return createHash("sha256")
    .update(`${toolName}\0${JSON.stringify(normalize(params))}`)
    .digest("hex");
}

export function requiresHighImpactVoiceConfirmation(toolName: string, params: unknown): boolean {
  const normalizedTool = toolName.trim().toLowerCase();
  if (!buildToolMutationState(normalizedTool, params).mutatingAction) {
    return false;
  }
  if (
    [
      "message",
      "gateway",
      "nodes",
      "browser",
      "computer",
      "mobile_ui",
      "canvas",
      AUTOMATIONS_TOOL_NAME,
      "process",
    ].includes(normalizedTool)
  ) {
    return true;
  }
  // Workspace-local edits stay bound to this run. Session delegation is gated because
  // delegated runs leave the voice binding and otherwise bypass spoken confirmation.
  if (
    ["write", "edit", "apply_patch", "create_goal", "update_goal", "get_goal"].includes(
      normalizedTool,
    )
  ) {
    return false;
  }
  return true;
}

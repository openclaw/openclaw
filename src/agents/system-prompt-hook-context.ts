import { normalizeStructuredPromptSection } from "./prompt-cache-stability.js";

const PLUGIN_SYSTEM_CONTEXT_HEADING = "# OpenClaw Plugin System Context";
const PLUGIN_SYSTEM_CONTEXT_NOTE =
  "The following instructions were supplied by OpenClaw plugins. They are not part of any workspace file or project document.";

function normalizeSystemContext(text: string | undefined): string {
  if (typeof text !== "string") {
    return "";
  }
  return normalizeStructuredPromptSection(text);
}

export function wrapPluginSystemContextSection(text: string | undefined): string | undefined {
  const normalized = normalizeSystemContext(text);
  if (!normalized) {
    return undefined;
  }
  return [
    "---",
    PLUGIN_SYSTEM_CONTEXT_HEADING,
    "",
    PLUGIN_SYSTEM_CONTEXT_NOTE,
    "",
    normalized,
    "",
    "---",
  ].join("\n");
}

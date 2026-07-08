import type { PluginToolRegistration } from "../registry-types.js";

const LEGACY_CONVERSATION_READ_TOOLS = new Set(["feishu:feishu_chat"]);

function normalizeContractName(value: string): string {
  return value.trim().toLowerCase();
}

export function isLegacyConversationReadTool(params: {
  pluginId: string;
  toolName: string;
}): boolean {
  return LEGACY_CONVERSATION_READ_TOOLS.has(
    `${normalizeContractName(params.pluginId)}:${normalizeContractName(params.toolName)}`,
  );
}

export function registrationIncludesLegacyConversationReadTool(
  entry: PluginToolRegistration,
): boolean {
  return [...entry.names, ...(entry.declaredNames ?? [])].some((toolName) =>
    isLegacyConversationReadTool({ pluginId: entry.pluginId, toolName }),
  );
}

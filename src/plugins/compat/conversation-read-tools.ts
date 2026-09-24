import type { PluginManifestRecord } from "../manifest-registry.js";
import type { PluginToolRegistration } from "../registry-types.js";

const HOST_RESTRICTED_CONVERSATION_READ_TOOLS = new Set(["feishu:feishu_chat"]);

function normalizeContractName(value: string): string {
  return value.trim().toLowerCase();
}

export function isHostRestrictedConversationReadTool(params: {
  pluginId: string;
  toolName: string;
}): boolean {
  return HOST_RESTRICTED_CONVERSATION_READ_TOOLS.has(
    `${normalizeContractName(params.pluginId)}:${normalizeContractName(params.toolName)}`,
  );
}

export function registrationIncludesHostRestrictedConversationReadTool(
  entry: PluginToolRegistration,
): boolean {
  // The gate must reflect the tools this registration actually produces
  // (`names`), not the full manifest contract (`declaredNames`). A non-bundled
  // Feishu registration that produces feishu_doc still declares feishu_chat in
  // its contract; checking declaredNames would collaterally drop feishu_doc.
  // Fall back to declaredNames only when the registration has no produced names
  // yet, preserving the fail-closed contract for unnamed registrations.
  const producibleNames = entry.names.length > 0 ? entry.names : (entry.declaredNames ?? []);
  return producibleNames.some((toolName) =>
    isHostRestrictedConversationReadTool({ pluginId: entry.pluginId, toolName }),
  );
}

export function isBundledConversationReadToolRegistration(params: {
  entry: PluginToolRegistration;
  manifestPlugin: PluginManifestRecord | undefined;
}): boolean {
  return params.entry.origin === "bundled" && params.manifestPlugin?.origin === "bundled";
}

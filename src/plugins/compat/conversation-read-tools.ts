import { normalizeConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
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

export function listHostRestrictedConversationReadToolsForRegistration(
  entry: PluginToolRegistration,
): string[] {
  // The gate must reflect the tools this registration actually produces
  // (`names`), not the full manifest contract (`declaredNames`). A non-bundled
  // Feishu registration that produces feishu_doc still declares feishu_chat in
  // its contract; checking declaredNames would collaterally drop feishu_doc.
  // Fall back to declaredNames only when the registration has no produced names
  // yet, preserving the fail-closed contract for unnamed registrations.
  const producibleNames = entry.names.length > 0 ? entry.names : (entry.declaredNames ?? []);
  const restricted: string[] = [];
  for (const toolName of producibleNames) {
    if (isHostRestrictedConversationReadTool({ pluginId: entry.pluginId, toolName })) {
      restricted.push(toolName);
    }
  }
  return restricted;
}

export function isBundledConversationReadToolRegistration(params: {
  entry: PluginToolRegistration;
  manifestPlugin: PluginManifestRecord | undefined;
}): boolean {
  return params.entry.origin === "bundled" && params.manifestPlugin?.origin === "bundled";
}

export function shouldRestrictConversationReadTools(params: {
  conversationReadOrigin: unknown;
  entry: PluginToolRegistration;
  manifestPlugin: PluginManifestRecord | undefined;
}): boolean {
  return (
    normalizeConversationReadInvocationOrigin(params.conversationReadOrigin) !==
      "direct-operator" && !isBundledConversationReadToolRegistration(params)
  );
}

export function formatHostRestrictedConversationReadExclusion(
  entry: PluginToolRegistration,
  restrictedTools: readonly string[],
  manifestPlugin: PluginManifestRecord | undefined,
): string {
  return `plugin tool excluded in delegated turn (${entry.pluginId}: ${restrictedTools.join(", ")}): conversation-read tools require bundled plugin origin (registration=${entry.origin ?? "unknown"}, manifest=${manifestPlugin?.origin ?? "unknown"})`;
}

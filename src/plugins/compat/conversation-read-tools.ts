import { normalizeConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import type { PluginManifestRecord } from "../manifest-registry.js";
import type { PluginRegistry, PluginToolRegistration } from "../registry-types.js";

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

export function registrationIncludesHostRestrictedConversationReadTool(
  entry: PluginToolRegistration,
): boolean {
  return listHostRestrictedConversationReadToolsForRegistration(entry).length > 0;
}

export function isBundledConversationReadToolRegistration(params: {
  entry: PluginToolRegistration;
  manifestPlugin: PluginManifestRecord | undefined;
}): boolean {
  return params.entry.origin === "bundled" && params.manifestPlugin?.origin === "bundled";
}

export function recordHostRestrictedConversationReadExclusion(params: {
  registry: PluginRegistry;
  entry: PluginToolRegistration;
  restrictedTools: readonly string[];
  manifestPlugin: PluginManifestRecord | undefined;
  warn: (message: string) => void;
}): void {
  const message = `plugin tool excluded in delegated turn (${params.entry.pluginId}: ${params.restrictedTools.join(", ")}): conversation-read tools require bundled plugin origin (registration=${params.entry.origin ?? "unknown"}, manifest=${params.manifestPlugin?.origin ?? "unknown"})`;
  if (
    !params.registry.diagnostics.some(
      (entry) =>
        entry.level === "warn" &&
        entry.pluginId === params.entry.pluginId &&
        entry.source === params.entry.source &&
        entry.message === message,
    )
  ) {
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: params.entry.pluginId,
      source: params.entry.source,
      message,
    });
    params.warn(message);
  }
}

export function excludeHostRestrictedConversationReadRegistration(params: {
  restrict: boolean;
  registry: PluginRegistry;
  entry: PluginToolRegistration;
  manifestPlugin: PluginManifestRecord | undefined;
  warn: (message: string) => void;
}): boolean {
  if (!params.restrict) {
    return false;
  }
  const restrictedTools = listHostRestrictedConversationReadToolsForRegistration(params.entry);
  if (restrictedTools.length === 0) {
    return false;
  }
  recordHostRestrictedConversationReadExclusion({ ...params, restrictedTools });
  return true;
}

export function excludeHostRestrictedConversationReadTool(params: {
  restrict: boolean;
  registry: PluginRegistry;
  entry: PluginToolRegistration;
  toolName: string;
  manifestPlugin: PluginManifestRecord | undefined;
  warn: (message: string) => void;
}): boolean {
  if (
    !params.restrict ||
    !isHostRestrictedConversationReadTool({
      pluginId: params.entry.pluginId,
      toolName: params.toolName,
    })
  ) {
    return false;
  }
  recordHostRestrictedConversationReadExclusion({ ...params, restrictedTools: [params.toolName] });
  return true;
}

export function createConversationReadToolGate(
  conversationReadOrigin: unknown,
  registry: PluginRegistry,
  entry: PluginToolRegistration,
  manifestPlugin: PluginManifestRecord | undefined,
  logger: { warn: (message: string) => void },
) {
  const restrict =
    normalizeConversationReadInvocationOrigin(conversationReadOrigin) !== "direct-operator" &&
    !isBundledConversationReadToolRegistration({ entry, manifestPlugin });
  const warn = (message: string) => logger.warn(message);
  return {
    excludeRegistration: () =>
      excludeHostRestrictedConversationReadRegistration({
        restrict,
        registry,
        entry,
        manifestPlugin,
        warn,
      }),
    excludeTool: (toolName: string) =>
      excludeHostRestrictedConversationReadTool({
        restrict,
        registry,
        entry,
        toolName,
        manifestPlugin,
        warn,
      }),
  };
}

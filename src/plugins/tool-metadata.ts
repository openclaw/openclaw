/** Dependency-light ownership metadata for plugin-contributed agent tools. */
import type { McpCodexToolAnnotations } from "../agents/mcp-codex-tool-approval.js";
import { normalizeToolPolicyName } from "../agents/tool-policy-shared.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { McpCodexToolApprovalMode } from "../config/types.mcp.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginRegistry } from "./registry-types.js";

/** MCP bridge metadata attached to plugin tools surfaced through agent tool lists. */
export type PluginToolMcpMeta = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  operation: "tool" | "resources_list" | "resources_read" | "prompts_list" | "prompts_get";
  excludedFromOpenClawCatalog?: true;
  deniedBySession?: true;
  /** Server-level instructions advertised by this tool's MCP server, if any. */
  instructions?: string;
  /** Trusted requester OAuth sign-in bootstrap; exempt from per-call MCP approval. */
  oauthConnectBootstrap?: true;
  codexApproval?: {
    mode?: McpCodexToolApprovalMode;
    annotations?: McpCodexToolAnnotations;
  };
  node?: {
    id: string;
    displayName?: string;
  };
};

/** Runtime metadata used to trace an agent tool back to its owning plugin registration. */
type PluginToolMeta = {
  pluginId: string;
  kind?: PluginManifestRecord["kind"];
  optional: boolean;
  workspaceAccess?: boolean | "execute";
  replaySafe?: boolean;
  sideEffecting?: boolean;
  trustedLocalMedia?: boolean;
  mcp?: PluginToolMcpMeta;
};

const pluginToolMeta = new WeakMap<object, PluginToolMeta>();

/** Attaches plugin ownership metadata to a concrete agent tool instance. */
export function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void {
  pluginToolMeta.set(tool, meta);
}

/** Reads plugin ownership metadata for a concrete agent tool instance. */
export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

/** Shared catalog/report provenance; names never establish a tool's owner. */
export function classifyAgentToolSource(tool: object): {
  source: "openclaw" | "mcp";
  sourceName: string;
  mcp?: PluginToolMcpMeta;
} {
  const meta = pluginToolMeta.get(tool);
  const pluginId = meta?.pluginId?.trim();
  const mcp = meta?.mcp;
  if (mcp) {
    return { source: "mcp", sourceName: mcp.safeServerName || pluginId || "mcp", mcp };
  }
  if (pluginId === "bundle-mcp") {
    return { source: "mcp", sourceName: pluginId };
  }
  return { source: "openclaw", sourceName: pluginId || "core" };
}

/** Copies plugin ownership metadata when wrappers replace a tool object. */
export function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void {
  const meta = pluginToolMeta.get(source);
  if (meta) {
    pluginToolMeta.set(target, meta);
  }
}

/** Builds a collision-proof key for plugin-owned tool metadata lookups. */
function buildPluginToolMetadataKey(pluginId: string, toolName: string): string {
  return JSON.stringify([pluginId, toolName]);
}

/** Prepare an ownership-scoped lookup from the caller's admitted metadata. */
export function createPluginToolMetadataLookup(entries: PluginRegistry["toolMetadata"] = []) {
  const byOwnerAndName = new Map<string, PluginRegistry["toolMetadata"][number]["metadata"]>();
  for (const { pluginId, metadata } of entries) {
    byOwnerAndName.set(buildPluginToolMetadataKey(pluginId, metadata.toolName), metadata);
  }
  return (pluginId: string, toolName: string) =>
    byOwnerAndName.get(buildPluginToolMetadataKey(pluginId, toolName));
}

/** Binds a side-effect declaration to the concrete plugin tool that owns it. */
export function getPluginToolSideEffectOwnerKey(tool: AnyAgentTool): string | undefined {
  const meta = getPluginToolMeta(tool);
  const toolName = normalizeToolPolicyName(tool.name);
  return meta?.sideEffecting && toolName
    ? buildPluginToolMetadataKey(meta.pluginId, toolName)
    : undefined;
}

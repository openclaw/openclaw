// Pure extraction of MCP App (ui://) previews from tool result details.
// Mirrors the `details.mcpApp` shape produced by src/agents mcp-apps support.
import type { McpAppToolPreview, ResolvedMcpAppToolPreview } from "./chat-types.ts";

const MCP_APP_VIEW_ID_PATTERN = /^mcpview_[A-Za-z0-9_-]{32}$/;
const MAX_INLINE_APP_HTML_CHARS = 6 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw.filter(
    (entry): entry is string => typeof entry === "string" && Boolean(entry),
  );
  return values.length > 0 ? values : undefined;
}

/**
 * Builds an MCP App preview from a tool result's `details` payload. Returns
 * undefined when the details carry no renderable app document.
 */
export function extractMcpAppPreview(
  details: unknown,
  _toolInput?: unknown,
): McpAppToolPreview | undefined {
  if (!isRecord(details) || !isRecord(details.mcpApp)) {
    return undefined;
  }
  const mcpApp = details.mcpApp;
  const viewId = typeof mcpApp.viewId === "string" ? mcpApp.viewId : "";
  const serverName = typeof mcpApp.serverName === "string" ? mcpApp.serverName.trim() : "";
  if (!MCP_APP_VIEW_ID_PATTERN.test(viewId) || !serverName) {
    return undefined;
  }
  const toolName = typeof mcpApp.toolName === "string" ? mcpApp.toolName : undefined;
  return {
    kind: "mcp-app",
    serverName,
    viewId,
    ...(toolName ? { title: toolName } : {}),
    ...(typeof mcpApp.resourceUri === "string" && mcpApp.resourceUri
      ? { resourceUri: mcpApp.resourceUri }
      : {}),
  };
}

/** Validate the untrusted Gateway response before it reaches the sandbox host. */
export function resolveMcpAppPreviewPayload(
  preview: McpAppToolPreview,
  raw: unknown,
): ResolvedMcpAppToolPreview | undefined {
  if (!isRecord(raw) || raw.serverName !== preview.serverName) {
    return undefined;
  }
  const resource = isRecord(raw.resource) ? raw.resource : undefined;
  const html = typeof resource?.html === "string" ? resource.html : "";
  const resourceUri = typeof resource?.uri === "string" ? resource.uri : "";
  if (
    !html ||
    html.length > MAX_INLINE_APP_HTML_CHARS ||
    (preview.resourceUri !== undefined && resourceUri !== preview.resourceUri)
  ) {
    return undefined;
  }
  const csp = isRecord(resource?.csp)
    ? {
        ...(normalizeStringList(resource.csp.connectDomains)
          ? { connectDomains: normalizeStringList(resource.csp.connectDomains) }
          : {}),
        ...(normalizeStringList(resource.csp.resourceDomains)
          ? { resourceDomains: normalizeStringList(resource.csp.resourceDomains) }
          : {}),
        ...(normalizeStringList(resource.csp.frameDomains)
          ? { frameDomains: normalizeStringList(resource.csp.frameDomains) }
          : {}),
        ...(normalizeStringList(resource.csp.baseUriDomains)
          ? { baseUriDomains: normalizeStringList(resource.csp.baseUriDomains) }
          : {}),
      }
    : undefined;
  const result = isRecord(raw.result) ? raw.result : undefined;
  const resultMeta = result?.["_meta"];
  return {
    ...preview,
    html,
    ...(resourceUri ? { resourceUri } : {}),
    ...(csp && Object.keys(csp).length > 0 ? { csp } : {}),
    ...(normalizeStringList(resource?.permissions)
      ? { permissions: normalizeStringList(resource?.permissions) }
      : {}),
    ...(resource?.prefersBorder === true ? { prefersBorder: true } : {}),
    ...(raw.toolInput !== undefined ? { toolInput: raw.toolInput } : {}),
    ...(result
      ? {
          toolResult: {
            ...(Array.isArray(result.content) ? { content: result.content } : {}),
            ...(result.structuredContent !== undefined
              ? { structuredContent: result.structuredContent }
              : {}),
            ...(isRecord(resultMeta) ? { _meta: resultMeta } : {}),
          },
        }
      : {}),
  };
}

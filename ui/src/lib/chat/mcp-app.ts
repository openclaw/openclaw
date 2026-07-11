// Pure extraction of MCP App (ui://) previews from tool result details.
// Mirrors the `details.mcpApp` shape produced by src/agents mcp-apps support.
import type { McpAppToolPreview } from "./chat-types.ts";

// Guard against pathological payloads reaching the DOM; the producer already
// caps documents at 5MB, so anything larger here is malformed or hostile.
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
  toolInput?: unknown,
): McpAppToolPreview | undefined {
  if (!isRecord(details) || !isRecord(details.mcpApp)) {
    return undefined;
  }
  const mcpApp = details.mcpApp;
  const resource = isRecord(mcpApp.resource) ? mcpApp.resource : undefined;
  const html = typeof resource?.html === "string" ? resource.html : "";
  if (!html || html.length > MAX_INLINE_APP_HTML_CHARS) {
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
  const result = isRecord(mcpApp.result) ? mcpApp.result : undefined;
  const resultMeta = result?.["_meta"];
  const toolName = typeof mcpApp.toolName === "string" ? mcpApp.toolName : undefined;
  // Details carry the authoritative input: transcripts split tool calls and
  // results into separate messages, so call-site args may be unavailable.
  const resolvedToolInput = mcpApp.toolInput !== undefined ? mcpApp.toolInput : toolInput;
  return {
    kind: "mcp-app",
    ...(toolName ? { title: toolName } : {}),
    html,
    ...(typeof resource?.uri === "string" && resource.uri ? { resourceUri: resource.uri } : {}),
    ...(csp && Object.keys(csp).length > 0 ? { csp } : {}),
    ...(normalizeStringList(resource?.permissions)
      ? { permissions: normalizeStringList(resource?.permissions) }
      : {}),
    ...(resource?.prefersBorder === true ? { prefersBorder: true } : {}),
    ...(resolvedToolInput !== undefined ? { toolInput: resolvedToolInput } : {}),
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

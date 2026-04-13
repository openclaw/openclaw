/**
 * MCP App resource registry.
 *
 * MCP Apps declare a `ui://` resource URI in their tool's `mcpAppUi.resourceUri`.
 * Callers fetch HTML content from this registry via `resolveResourceContent()`.
 * The registry supports three source types:
 *
 *   builtin — bundled HTML string, registered at startup time
 *   file    — read from the local filesystem on demand (e.g. agent workspace)
 *   canvas  — served through the OpenClaw canvas host URL
 */
import fs from "node:fs/promises";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";

/** Maximum resource HTML size (2 MB). Content beyond this limit is rejected. */
export const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;

/** MIME type advertised for all MCP App HTML resources. */
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Default content-security policy applied to MCP App iframes.
 * Callers may append additional directives through `McpAppUiMeta.csp`,
 * subject to the allowlist enforced in `buildResourceCsp()`.
 */
export const MCP_APP_DEFAULT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
].join("; ");

/** CSP directives that tools are permitted to extend via `mcpAppUi.csp`. */
const CSP_DIRECTIVE_ALLOWLIST = new Set([
  "script-src",
  "style-src",
  "img-src",
  "connect-src",
  "font-src",
]);

/** A resource source backed by a literal HTML string bundled at startup. */
type BuiltinSource = { type: "builtin"; html: string };

/**
 * A resource source backed by a file read from the local filesystem.
 * The resolved path must remain under `rootDir` (path traversal is rejected).
 */
type FileSource = { type: "file"; rootDir: string; relativePath: string };

/**
 * A resource source where the HTML is served through the canvas host.
 * The resolved URL is returned as the `text` content directly.
 */
type CanvasSource = { type: "canvas"; canvasUrl: string };

type McpAppResourceSource = BuiltinSource | FileSource | CanvasSource;

export type McpAppResource = {
  uri: string;
  name: string;
  mimeType: string;
  source: McpAppResourceSource;
};

const registry = new Map<string, McpAppResource>();

// ---------------------------------------------------------------------------
// Registration API
// ---------------------------------------------------------------------------

/**
 * Register a builtin resource backed by an inline HTML string.
 *
 * @example
 * registerBuiltinResource({
 *   uri: "ui://openclaw-charts/chart.html",
 *   name: "Chart Renderer",
 *   html: "<!DOCTYPE html>...",
 * });
 */
export function registerBuiltinResource(params: { uri: string; name: string; html: string }): void {
  const byteLength = Buffer.byteLength(params.html, "utf8");
  if (byteLength > MCP_APP_RESOURCE_MAX_BYTES) {
    logWarn(
      `mcp-app-resources: rejecting builtin resource "${params.uri}" — ${byteLength} bytes exceeds 2 MB limit`,
    );
    return;
  }
  if (registry.has(params.uri)) {
    logWarn(`mcp-app-resources: overwriting already-registered resource "${params.uri}"`);
  }
  registry.set(params.uri, {
    uri: params.uri,
    name: params.name,
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    source: { type: "builtin", html: params.html },
  });
}

/**
 * Register a file-backed resource.
 *
 * The file will be read from `rootDir/relativePath` on demand.
 * Path traversal is blocked — `relativePath` must not escape `rootDir`.
 */
export function registerFileResource(params: {
  uri: string;
  name: string;
  rootDir: string;
  relativePath: string;
}): void {
  if (registry.has(params.uri)) {
    logWarn(`mcp-app-resources: overwriting already-registered resource "${params.uri}"`);
  }
  registry.set(params.uri, {
    uri: params.uri,
    name: params.name,
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    source: { type: "file", rootDir: params.rootDir, relativePath: params.relativePath },
  });
}

/**
 * Register a canvas-backed resource.
 * The `canvasUrl` is returned directly as the resource text content.
 */
export function registerCanvasResource(params: {
  uri: string;
  name: string;
  canvasUrl: string;
}): void {
  if (registry.has(params.uri)) {
    logWarn(`mcp-app-resources: overwriting already-registered resource "${params.uri}"`);
  }
  registry.set(params.uri, {
    uri: params.uri,
    name: params.name,
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    source: { type: "canvas", canvasUrl: params.canvasUrl },
  });
}

/** Remove a previously registered resource. Returns true if it existed. */
export function unregisterResource(uri: string): boolean {
  return registry.delete(uri);
}

// ---------------------------------------------------------------------------
// Query API
// ---------------------------------------------------------------------------

/** Snapshot of all registered MCP App resources (read-only). */
export function listResources(): Pick<McpAppResource, "uri" | "name" | "mimeType">[] {
  return [...registry.values()].map(({ uri, name, mimeType }) => ({ uri, name, mimeType }));
}

/** Lookup a resource entry by URI without reading its content. */
export function getResource(uri: string): McpAppResource | undefined {
  return registry.get(uri);
}

// ---------------------------------------------------------------------------
// Content resolution
// ---------------------------------------------------------------------------

type ResourceContent = {
  uri: string;
  mimeType: string;
  text: string;
};

type ResolveResult = { ok: true; content: ResourceContent } | { ok: false; error: string };

/**
 * Resolve the HTML content for a registered `ui://` URI.
 *
 * Performs size-limit enforcement and path-traversal checks.
 * Returns `{ ok: false }` for unknown URIs or content that exceeds the size limit.
 */
export async function resolveResourceContent(uri: string): Promise<ResolveResult> {
  const resource = registry.get(uri);
  if (!resource) {
    return { ok: false, error: `resource not found: ${uri}` };
  }

  const { source } = resource;

  if (source.type === "builtin") {
    const byteLength = Buffer.byteLength(source.html, "utf8");
    if (byteLength > MCP_APP_RESOURCE_MAX_BYTES) {
      return { ok: false, error: `resource "${uri}" exceeds 2 MB size limit` };
    }
    return { ok: true, content: { uri, mimeType: resource.mimeType, text: source.html } };
  }

  if (source.type === "canvas") {
    return { ok: true, content: { uri, mimeType: resource.mimeType, text: source.canvasUrl } };
  }

  // type === "file"
  const path = await import("node:path");
  const resolvedRoot = path.resolve(source.rootDir);
  const candidate = path.resolve(source.rootDir, source.relativePath);
  if (!candidate.startsWith(resolvedRoot + path.sep) && candidate !== resolvedRoot) {
    return { ok: false, error: `resource "${uri}" has invalid path (traversal rejected)` };
  }

  try {
    const buf = await fs.readFile(candidate);
    if (buf.byteLength > MCP_APP_RESOURCE_MAX_BYTES) {
      return { ok: false, error: `resource "${uri}" exceeds 2 MB size limit` };
    }
    return { ok: true, content: { uri, mimeType: resource.mimeType, text: buf.toString("utf8") } };
  } catch (error) {
    const message = formatErrorMessage(error);
    return { ok: false, error: `failed to read resource "${uri}": ${message}` };
  }
}

// ---------------------------------------------------------------------------
// CSP helpers
// ---------------------------------------------------------------------------

/**
 * Build a merged CSP string for an MCP App tool.
 *
 * Starts from `MCP_APP_DEFAULT_CSP` and extends individual directives
 * with allowlisted values from `extraCsp`. Directives not on the allowlist
 * are silently ignored so tools cannot inject `allow-same-origin` or similar.
 */
export function buildResourceCsp(extraCsp: Record<string, string[]> | undefined): string {
  if (!extraCsp || Object.keys(extraCsp).length === 0) {
    return MCP_APP_DEFAULT_CSP;
  }

  // Parse default directives into a mutable map
  const parts = new Map<string, string[]>();
  for (const directive of MCP_APP_DEFAULT_CSP.split(";").map((s) => s.trim())) {
    if (!directive) {
      continue;
    }
    const spaceIdx = directive.indexOf(" ");
    if (spaceIdx === -1) {
      parts.set(directive, []);
    } else {
      const name = directive.slice(0, spaceIdx);
      const values = directive
        .slice(spaceIdx + 1)
        .split(" ")
        .filter(Boolean);
      parts.set(name, values);
    }
  }

  // Merge allowlisted extra directives
  for (const [directive, values] of Object.entries(extraCsp)) {
    if (!CSP_DIRECTIVE_ALLOWLIST.has(directive)) {
      logWarn(`mcp-app-resources: ignoring non-allowlisted CSP directive "${directive}"`);
      continue;
    }
    const existing = parts.get(directive) ?? [];
    // Deduplicate merged values
    parts.set(directive, [...new Set([...existing, ...values])]);
  }

  return [...parts.entries()]
    .map(([directive, values]) =>
      values.length === 0 ? directive : `${directive} ${values.join(" ")}`,
    )
    .join("; ");
}

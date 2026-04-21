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
import type {
  AnyAgentTool,
  McpAppResourceMeta,
  McpAppResourceSource,
  McpUiResourceCsp,
} from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";

/** Maximum resource HTML size (2 MB). Content beyond this limit is rejected. */
export const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;

/** MIME type advertised for all MCP App HTML resources. */
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Default content-security policy applied to MCP App iframes.
 * Callers may extend this through domain-based declarations in
 * `McpAppResourceMeta.csp`, which `buildResourceCsp()` translates
 * into CSP header directives.
 */
export const MCP_APP_DEFAULT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

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

type InternalResourceSource = BuiltinSource | FileSource | CanvasSource;

export type McpAppResource = {
  uri: string;
  name: string;
  mimeType: string;
  source: InternalResourceSource;
  /** SEP-1865 resource metadata — returned in `resources/read` as `_meta.ui`. */
  metadata?: McpAppResourceMeta;
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
export function registerBuiltinResource(params: {
  uri: string;
  name: string;
  html: string;
  metadata?: McpAppResourceMeta;
}): void {
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
    metadata: params.metadata,
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
  metadata?: McpAppResourceMeta;
}): void {
  if (registry.has(params.uri)) {
    logWarn(`mcp-app-resources: overwriting already-registered resource "${params.uri}"`);
  }
  registry.set(params.uri, {
    uri: params.uri,
    name: params.name,
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    source: { type: "file", rootDir: params.rootDir, relativePath: params.relativePath },
    metadata: params.metadata,
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
  metadata?: McpAppResourceMeta;
}): void {
  if (registry.has(params.uri)) {
    logWarn(`mcp-app-resources: overwriting already-registered resource "${params.uri}"`);
  }
  registry.set(params.uri, {
    uri: params.uri,
    name: params.name,
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    source: { type: "canvas", canvasUrl: params.canvasUrl },
    metadata: params.metadata,
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
  _meta?: { ui: McpAppResourceMeta };
};

type ResolveResult = { ok: true; content: ResourceContent } | { ok: false; error: string };

/**
 * Resolve the HTML content for a registered `ui://` URI.
 *
 * Performs size-limit enforcement and path-traversal checks.
 * Returns `{ ok: false }` for unknown URIs or content that exceeds the size limit.
 *
 * When the resource has metadata (CSP, permissions, etc.), it is included
 * as `_meta.ui` on the returned content block per SEP-1865.
 */
export async function resolveResourceContent(uri: string): Promise<ResolveResult> {
  const resource = registry.get(uri);
  if (!resource) {
    return { ok: false, error: `resource not found: ${uri}` };
  }

  const { source, metadata, mimeType } = resource;

  function buildContent(text: string): ResourceContent {
    const content: ResourceContent = { uri, mimeType, text };
    if (metadata && Object.keys(metadata).length > 0) {
      content._meta = { ui: metadata };
    }
    return content;
  }

  if (source.type === "builtin") {
    // Defense-in-depth: registerBuiltinResource() already rejects oversized
    // content at registration time, but we re-check at read time in case the
    // internal registry is ever mutated directly or the registration guard
    // is bypassed by a future code path.
    const byteLength = Buffer.byteLength(source.html, "utf8");
    if (byteLength > MCP_APP_RESOURCE_MAX_BYTES) {
      return { ok: false, error: `resource "${uri}" exceeds 2 MB size limit` };
    }
    return { ok: true, content: buildContent(source.html) };
  }

  if (source.type === "canvas") {
    // Wrap the canvas URL in a minimal HTML document so that `resources/read`
    // returns renderable HTML content, consistent with the MCP Apps spec.
    // The original URL is embedded as a full-viewport iframe redirect.
    const escapedUrl = source.canvasUrl
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}iframe{width:100%;height:100vh;border:0}</style></head><body><iframe src="${escapedUrl}" sandbox="allow-scripts allow-same-origin" loading="eager"></iframe></body></html>`;
    return { ok: true, content: buildContent(html) };
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
    return { ok: true, content: buildContent(buf.toString("utf8")) };
  } catch (error) {
    const message = formatErrorMessage(error);
    return { ok: false, error: `failed to read resource "${uri}": ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Auto-sync: bridge from tool declarations to resource registry
// ---------------------------------------------------------------------------

/**
 * Per-owner tracking of URIs that were auto-registered by `syncMcpAppResources`.
 * Each cache surface (HTTP loopback, WS) passes a unique `owner` key so that
 * one surface's cache refresh does not evict resources registered by another.
 * Manual registrations (via direct `register*Resource` calls) are not tracked
 * here and will never be evicted by the sync.
 */
const autoSyncedByOwner = new Map<string, Set<string>>();

/**
 * Reconcile the resource registry with the current set of resolved tools.
 *
 * For each tool that declares `mcpAppUi.resourceSource`, registers (or updates)
 * the matching resource. After processing all tools, any previously auto-synced
 * resources that are no longer present **for this owner** are unregistered —
 * but only when no other owner still claims the same URI.
 *
 * @param tools  The full set of currently active tools for this surface.
 * @param owner  A stable identifier for the calling cache surface (e.g.
 *               `"http"` or `"ws"`). Defaults to `"default"` for backward
 *               compatibility with single-surface callers and tests.
 *
 * This is called from `McpLoopbackToolCache.resolve()` on every cache refresh
 * (≤30 s cadence), so the resource registry stays in sync with the active tool set.
 */
export function syncMcpAppResources(tools: AnyAgentTool[], owner = "default"): void {
  const currentUris = new Set<string>();

  for (const tool of tools) {
    const ui = (
      tool as {
        mcpAppUi?: {
          resourceUri?: string;
          resourceSource?: McpAppResourceSource;
          resourceMeta?: McpAppResourceMeta;
        };
      }
    ).mcpAppUi;
    if (!ui?.resourceUri || !ui.resourceSource) {
      continue;
    }

    const { resourceUri, resourceSource, resourceMeta } = ui;
    const name = tool.description ?? tool.name;
    currentUris.add(resourceUri);

    switch (resourceSource.type) {
      case "builtin":
        registerBuiltinResource({
          uri: resourceUri,
          name,
          html: resourceSource.html,
          metadata: resourceMeta,
        });
        break;
      case "file":
        registerFileResource({
          uri: resourceUri,
          name,
          rootDir: resourceSource.rootDir,
          relativePath: resourceSource.relativePath,
          metadata: resourceMeta,
        });
        break;
      case "canvas":
        registerCanvasResource({
          uri: resourceUri,
          name,
          canvasUrl: resourceSource.canvasUrl,
          metadata: resourceMeta,
        });
        break;
    }
  }

  const previouslyOwned = autoSyncedByOwner.get(owner) ?? new Set<string>();

  // Clean up orphaned auto-synced resources: URI was previously registered by
  // this owner but is no longer in the current tool set for this owner.
  for (const uri of previouslyOwned) {
    if (!currentUris.has(uri)) {
      // Only unregister if no OTHER owner still claims the URI.
      let claimedByOther = false;
      for (const [otherOwner, otherUris] of autoSyncedByOwner) {
        if (otherOwner !== owner && otherUris.has(uri)) {
          claimedByOther = true;
          break;
        }
      }
      if (!claimedByOther) {
        unregisterResource(uri);
      }
    }
  }

  // Update this owner's tracked set to exactly the current URIs.
  if (currentUris.size > 0) {
    autoSyncedByOwner.set(owner, currentUris);
  } else {
    autoSyncedByOwner.delete(owner);
  }
}

/** Reset auto-sync tracking. Exported for tests only. */
export function _resetAutoSyncState(): void {
  autoSyncedByOwner.clear();
}

// ---------------------------------------------------------------------------
// CSP helpers
// ---------------------------------------------------------------------------

/**
 * Build a CSP header string for an MCP App resource.
 *
 * Starts from `MCP_APP_DEFAULT_CSP` and extends directives using the
 * SEP-1865 domain-based declaration model:
 *
 *   - `connectDomains`  → `connect-src`
 *   - `resourceDomains` → `script-src`, `style-src`, `img-src`, `font-src`, `media-src`
 *   - `frameDomains`    → `frame-src`
 *   - `baseUriDomains`  → `base-uri`
 */
export function buildResourceCsp(csp: McpUiResourceCsp | undefined): string {
  if (!csp || Object.keys(csp).length === 0) {
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

  function extendDirective(name: string, domains: string[] | undefined): void {
    if (!domains?.length) {
      return;
    }
    const existing = parts.get(name) ?? [];
    // Remove the 'none' sentinel when we have real origins
    const filtered = existing.filter((v) => v !== "'none'");
    parts.set(name, [...new Set([...filtered, ...domains])]);
  }

  // connectDomains → connect-src
  extendDirective("connect-src", csp.connectDomains);

  // resourceDomains → multiple directives
  if (csp.resourceDomains?.length) {
    for (const dir of ["script-src", "style-src", "img-src", "font-src", "media-src"]) {
      extendDirective(dir, csp.resourceDomains);
    }
  }

  // frameDomains → frame-src (default is blocked)
  if (csp.frameDomains?.length) {
    parts.set("frame-src", [...new Set(csp.frameDomains)]);
  } else if (!parts.has("frame-src")) {
    parts.set("frame-src", ["'none'"]);
  }

  // baseUriDomains → base-uri
  if (csp.baseUriDomains?.length) {
    parts.set("base-uri", [...new Set(csp.baseUriDomains)]);
  }

  return [...parts.entries()]
    .map(([directive, values]) =>
      values.length === 0 ? directive : `${directive} ${values.join(" ")}`,
    )
    .join("; ");
}

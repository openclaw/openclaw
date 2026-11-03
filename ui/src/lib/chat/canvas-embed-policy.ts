import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import type { ControlUiEmbedSandboxMode } from "../../../../src/gateway/control-ui-bootstrap-contract.js";

export type EmbedSandboxMode = ControlUiEmbedSandboxMode;

const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";

function isCanvasHttpPath(pathname: string): boolean {
  return pathname === CANVAS_HOST_PATH || pathname.startsWith(`${CANVAS_HOST_PATH}/`);
}

function sanitizeCanvasEntryUrl(
  rawEntryUrl: string,
  allowExternalEmbedUrls = false,
): string | undefined {
  const entry = URL.parse(rawEntryUrl, "http://localhost");
  if (!entry) {
    return undefined;
  }
  if (entry.origin !== "http://localhost") {
    return allowExternalEmbedUrls && isHttpUrl(entry) ? entry.toString() : undefined;
  }
  return isCanvasHttpPath(entry.pathname)
    ? `${entry.pathname}${entry.search}${entry.hash}`
    : undefined;
}

/**
 * True when the preview entry URL points at a hosted Canvas document rather
 * than an externally allowed embed URL. Prompt authority (widget sendPrompt)
 * is granted only to internal Canvas documents.
 */
export function isInternalCanvasEntryUrl(entryUrl: string | undefined): boolean {
  const rawEntryUrl = entryUrl?.trim();
  return Boolean(rawEntryUrl && sanitizeCanvasEntryUrl(rawEntryUrl, false));
}

export function resolveCanvasIframeUrl(
  entryUrl: string | undefined,
  canvasPluginSurfaceUrl?: string | null,
  allowExternalEmbedUrls = false,
): string | undefined {
  const rawEntryUrl = entryUrl?.trim();
  if (!rawEntryUrl) {
    return undefined;
  }
  const safeEntryUrl = sanitizeCanvasEntryUrl(rawEntryUrl, allowExternalEmbedUrls);
  if (!safeEntryUrl) {
    return undefined;
  }
  if (!canvasPluginSurfaceUrl?.trim()) {
    return safeEntryUrl;
  }
  try {
    const scopedHostUrl = new URL(canvasPluginSurfaceUrl);
    const scopedPrefix = scopedHostUrl.pathname.replace(/\/+$/, "");
    if (!scopedPrefix.startsWith(CANVAS_CAPABILITY_PATH_PREFIX)) {
      return safeEntryUrl;
    }
    const entry = new URL(safeEntryUrl, scopedHostUrl.origin);
    if (!isCanvasHttpPath(entry.pathname)) {
      return safeEntryUrl;
    }
    entry.protocol = scopedHostUrl.protocol;
    entry.username = scopedHostUrl.username;
    entry.password = scopedHostUrl.password;
    entry.host = scopedHostUrl.host;
    entry.pathname = `${scopedPrefix}${entry.pathname}`;
    return entry.toString();
  } catch {
    return safeEntryUrl;
  }
}

export function resolveEmbedSandbox(
  mode: EmbedSandboxMode | null | undefined,
  ceiling?: "strict" | "scripts",
): string {
  if (ceiling === "strict" || mode === "strict") {
    return "";
  }
  return mode === "trusted" && ceiling !== "scripts"
    ? "allow-scripts allow-same-origin"
    : "allow-scripts";
}

import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import SHARED_TOOL_DISPLAY_JSON from "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import {
  defaultTitle,
  normalizeToolDisplayName,
  resolveToolVerbAndDetailForArgs,
  type ToolDisplaySpec,
} from "../../../../src/agents/tool-display-common.js";
import type { ToolDetailMode } from "../../../../src/agents/tool-display-exec.js";
import type { ControlUiEmbedSandboxMode } from "../../../../src/gateway/control-ui-bootstrap-contract.js";
import { resolveToolDisplayIcon } from "./tool-display-icon.ts";

const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";

type SharedToolDisplaySpec = ToolDisplaySpec & {
  emoji?: string;
};

type ToolDisplay = {
  name: string;
  icon: ReturnType<typeof resolveToolDisplayIcon>;
  title: string;
  label: string;
  verb?: string;
  detail?: string;
};

export type EmbedSandboxMode = ControlUiEmbedSandboxMode;

const FALLBACK = SHARED_TOOL_DISPLAY_JSON.fallback;
const TOOL_MAP: Record<string, SharedToolDisplaySpec> = SHARED_TOOL_DISPLAY_JSON.tools;

function shortenHomeInString(input: string): string {
  // Browser-safe home shortening: avoid importing Node-only helpers (keeps Vite builds working in Docker/CI).
  return input
    .replace(/^\/(?:Users|home)\/[^/]+(\/|$)/, "~$1")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(\\|$)/i, "~$1");
}

export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
  detailMode?: ToolDetailMode;
}): ToolDisplay {
  const name = normalizeToolDisplayName(params.name);
  const key = normalizeLowercaseStringOrEmpty(name);
  const spec = TOOL_MAP[key];
  const icon = resolveToolDisplayIcon(name);
  const title = spec?.title ?? defaultTitle(name);
  const label = spec?.label ?? title;
  const toolDisplayParts = resolveToolVerbAndDetailForArgs({
    toolKey: key,
    args: params.args,
    meta: params.meta,
    spec,
    fallbackDetailKeys: FALLBACK.detailKeys,
    detailMode: "first",
    toolDetailMode: params.detailMode,
    detailCoerce: { includeFalsy: true },
  });
  const { verb } = toolDisplayParts;
  let { detail } = toolDisplayParts;

  if (detail) {
    detail = shortenHomeInString(detail);
  }

  return {
    name,
    icon,
    title,
    label,
    verb,
    detail,
  };
}

export function formatToolDetail(display: ToolDisplay): string | undefined {
  return display.detail ? `with ${display.detail}` : undefined;
}

function isCanvasHttpPath(pathname: string): boolean {
  return (
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`)
  );
}

function sanitizeCanvasEntryUrl(
  rawEntryUrl: string,
  allowExternalEmbedUrls = false,
): string | undefined {
  try {
    const entry = new URL(rawEntryUrl, "http://localhost");
    if (entry.origin !== "http://localhost") {
      if (!allowExternalEmbedUrls || !isHttpUrl(entry)) {
        return undefined;
      }
      return entry.toString();
    }
    if (!isCanvasHttpPath(entry.pathname)) {
      return undefined;
    }
    return `${entry.pathname}${entry.search}${entry.hash}`;
  } catch {
    return undefined;
  }
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
  if (ceiling === "strict" || (ceiling === "scripts" && mode === "strict")) {
    return "";
  }
  if (ceiling === "scripts") {
    return "allow-scripts";
  }
  switch (mode) {
    case "strict":
      return "";
    case "trusted":
      return "allow-scripts allow-same-origin";
    default:
      return "allow-scripts";
  }
}

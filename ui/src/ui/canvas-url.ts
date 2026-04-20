const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";

function isCanvasHttpPath(pathname: string): boolean {
  return (
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`)
  );
}

function isExternalHttpUrl(entry: URL): boolean {
  return entry.protocol === "http:" || entry.protocol === "https:";
}

type SanitizedCanvasEntry =
  | {
      kind: "external";
      url: string;
    }
  | {
      kind: "protected-canvas";
      url: string;
    };

function sanitizeCanvasEntryUrl(
  rawEntryUrl: string,
  allowExternalEmbedUrls = false,
): SanitizedCanvasEntry | undefined {
  try {
    const entry = new URL(rawEntryUrl, "http://localhost");
    if (entry.origin !== "http://localhost") {
      if (!allowExternalEmbedUrls || !isExternalHttpUrl(entry)) {
        return undefined;
      }
      return {
        kind: "external",
        url: entry.toString(),
      };
    }
    if (!isCanvasHttpPath(entry.pathname)) {
      return undefined;
    }
    return {
      kind: "protected-canvas",
      url: `${entry.pathname}${entry.search}${entry.hash}`,
    };
  } catch {
    return undefined;
  }
}

function resolveScopedCanvasHostUrl(canvasHostUrl: string): URL | undefined {
  try {
    const scopedHostUrl = new URL(canvasHostUrl);
    const scopedPrefix = scopedHostUrl.pathname.replace(/\/+$/, "");
    const capabilityPrefix = `${CANVAS_CAPABILITY_PATH_PREFIX}/`;
    if (!scopedPrefix.startsWith(capabilityPrefix)) {
      return undefined;
    }
    const capability = scopedPrefix.slice(capabilityPrefix.length);
    if (!capability || capability.includes("/")) {
      return undefined;
    }
    return scopedHostUrl;
  } catch {
    return undefined;
  }
}

export function resolveCanvasIframeUrl(
  entryUrl: string | undefined,
  canvasHostUrl?: string | null,
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
  if (safeEntryUrl.kind === "external") {
    return safeEntryUrl.url;
  }
  const scopedHostUrl = canvasHostUrl?.trim()
    ? resolveScopedCanvasHostUrl(canvasHostUrl)
    : undefined;
  if (!scopedHostUrl) {
    return undefined;
  }
  const scopedPrefix = scopedHostUrl.pathname.replace(/\/+$/, "");
  const entry = new URL(safeEntryUrl.url, scopedHostUrl.origin);
  entry.protocol = scopedHostUrl.protocol;
  entry.username = scopedHostUrl.username;
  entry.password = scopedHostUrl.password;
  entry.host = scopedHostUrl.host;
  entry.pathname = `${scopedPrefix}${entry.pathname}`;
  return entry.toString();
}

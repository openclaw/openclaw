import { buildControlUiResourcePath } from "../../../../src/gateway/control-ui-resource-routes.js";
import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { hasSameOriginGatewayTransport } from "../../dev-gateway.ts";

const ALLOWED_PLUGIN_ICON_MIME_TYPES = new Set(["image/png", "image/svg+xml", "image/x-icon"]);
type PluginIconAuthSource = Parameters<typeof resolveControlUiAuthCandidates>[0];

function normalizeMimeType(contentType: string | null): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

type FetchProxiedIconParams = {
  auth: PluginIconAuthSource;
  authCandidates?: readonly string[];
  resourceBasePath: string;
  gatewayUrl: string;
  signal: AbortSignal;
};

export type PluginIconFetchContext = Omit<FetchProxiedIconParams, "signal"> & {
  theme?: "light" | "dark";
};

function cancelUnreadResponseBody(response: Response): void {
  if (!response.bodyUsed) {
    // Cancellation is best-effort cleanup; a stalled stream must not block
    // auth fallback or completion of the rejected icon request.
    void response.body?.cancel().catch(() => undefined);
  }
}

export async function fetchProxiedIconBlobUrl(
  params: FetchProxiedIconParams,
  routeUrl: string,
  svgOnly = false,
): Promise<string | null> {
  if (!hasSameOriginGatewayTransport(params.gatewayUrl)) {
    return null;
  }
  const authCandidates = params.authCandidates ?? resolveControlUiAuthCandidates(params.auth);
  const attempts = authCandidates.length > 0 ? authCandidates : [""];
  for (const candidate of attempts) {
    const headers: Record<string, string> = {
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml",
    };
    if (candidate) {
      headers.Authorization = `Bearer ${candidate}`;
    }
    const response = await fetch(routeUrl, {
      method: "GET",
      headers,
      credentials: "same-origin",
      signal: params.signal,
    });
    if (!response.ok) {
      // Retry and rejection paths never consume the stream. Release it without
      // delaying the auth fallback or the rejected icon result.
      cancelUnreadResponseBody(response);
      if (response.status === 401 || response.status === 403) {
        continue;
      }
      return null;
    }
    const contentType = normalizeMimeType(response.headers.get("content-type"));
    if (
      !ALLOWED_PLUGIN_ICON_MIME_TYPES.has(contentType) ||
      (svgOnly && contentType !== "image/svg+xml")
    ) {
      cancelUnreadResponseBody(response);
      return null;
    }
    const source = await response.blob();
    const rendered =
      contentType === "image/svg+xml"
        ? await import("./svg-icon-rasterizer.ts").then(({ rasterizeSvg }) => rasterizeSvg(source))
        : source;
    return rendered ? URL.createObjectURL(rendered) : null;
  }
  return null;
}

export function fetchPluginIconBlobUrl(
  params: FetchProxiedIconParams & { pluginId: string; theme?: "light" | "dark" },
): Promise<string | null> {
  const path = buildControlUiResourcePath("pluginIcon", params.resourceBasePath, params.pluginId);
  const routeUrl = params.theme ? `${path}?theme=${params.theme}` : path;
  return fetchProxiedIconBlobUrl(params, routeUrl);
}

export function fetchPluginActivityIconBlobUrl(
  params: FetchProxiedIconParams & { pluginId: string; tool?: string },
): Promise<string | null> {
  const path = buildControlUiResourcePath(
    "pluginActivityIcon",
    params.resourceBasePath,
    params.pluginId,
  );
  const routeUrl = params.tool ? `${path}?tool=${encodeURIComponent(params.tool)}` : path;
  return fetchProxiedIconBlobUrl(params, routeUrl, true);
}

export function fetchCatalogIconBlobUrl(
  params: FetchProxiedIconParams & { iconUrl: string },
): Promise<string | null> {
  const routeUrl = buildControlUiResourcePath(
    "catalogIcon",
    params.resourceBasePath,
    params.iconUrl,
  );
  return fetchProxiedIconBlobUrl(params, routeUrl);
}

export function fetchLinkFaviconBlobUrl(
  params: FetchProxiedIconParams & { hostname: string },
): Promise<string | null> {
  const routeUrl = buildControlUiResourcePath(
    "linkFavicon",
    params.resourceBasePath,
    params.hostname,
  );
  return fetchProxiedIconBlobUrl(params, routeUrl);
}

export type PluginThemeArtworkFetchParams = { url: string } & Partial<FetchProxiedIconParams>;

export function fetchPluginThemeArtworkBlobUrl(
  params: PluginThemeArtworkFetchParams,
): Promise<string | null> {
  return import("./theme-artwork-loader.ts").then(({ loadPluginThemeArtwork }) =>
    loadPluginThemeArtwork(params),
  );
}

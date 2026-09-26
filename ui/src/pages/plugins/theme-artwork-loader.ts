import { matchControlUiResourceUrl } from "../../../../src/gateway/control-ui-resource-routes.js";
import { readAvatarGatewayContext } from "../../lib/identity-avatar-context.ts";
import { fetchProxiedIconBlobUrl, type PluginThemeArtworkFetchParams } from "./icon-loader.ts";

// Content-addressed URLs retain both hits and misses for this page's lifetime.
const themeArtwork = new Map<string, Promise<string | null>>();

export function loadPluginThemeArtwork(
  params: PluginThemeArtworkFetchParams,
): Promise<string | null> {
  const cached = themeArtwork.get(params.url);
  if (cached) {
    return cached;
  }
  const context = readAvatarGatewayContext();
  const resourceBasePath = params.resourceBasePath ?? context.resourceBasePath;
  if (!matchControlUiResourceUrl("pluginThemeArt", params.url)) {
    return Promise.resolve(null);
  }
  const request = fetchProxiedIconBlobUrl(
    {
      auth: params.auth ?? {},
      authCandidates: params.auth ? undefined : context.authTokens,
      resourceBasePath,
      gatewayUrl: params.gatewayUrl ?? context.origin ?? window.location.origin,
      signal: params.signal ?? AbortSignal.timeout(15_000),
    },
    `${resourceBasePath}${params.url}`,
    true,
  ).catch(() => null);
  themeArtwork.set(params.url, request);
  return request;
}

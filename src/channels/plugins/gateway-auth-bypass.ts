/**
 * Channel gateway auth bypass loader.
 *
 * Reads optional public artifacts that declare unauthenticated Gateway callback paths.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryLoadActivatedBundledPluginPublicSurfaceModuleSync } from "../../plugin-sdk/facade-runtime.js";

/**
 * Lightweight public artifact contract for channel gateway auth bypass paths.
 */
type GatewayAuthBypassApi = {
  resolveGatewayAuthBypassPaths?: (params: { cfg: OpenClawConfig }) => readonly unknown[];
};

const GATEWAY_AUTH_API_ARTIFACT_BASENAME = "gateway-auth-api.js";
const MISSING_PUBLIC_SURFACE_PREFIX = "Unable to resolve bundled plugin public surface ";

function loadBundledChannelGatewayAuthApi(channelId: string): GatewayAuthBypassApi | undefined {
  try {
    // Bypass paths grant unauthenticated ingress, so resolution goes through the
    // activation-gated facade seam: it also covers installed (externalized) plugin
    // roots and returns null instead of executing a disabled plugin's artifact.
    return (
      tryLoadActivatedBundledPluginPublicSurfaceModuleSync<GatewayAuthBypassApi>({
        dirName: channelId,
        artifactBasename: GATEWAY_AUTH_API_ARTIFACT_BASENAME,
      }) ?? undefined
    );
  } catch (error) {
    // Missing gateway auth artifacts are optional. Any other load failure means
    // the artifact exists but cannot be trusted, so propagate it to callers.
    if (error instanceof Error && error.message.startsWith(MISSING_PUBLIC_SURFACE_PREFIX)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolves configured gateway auth bypass paths from a bundled channel artifact.
 */
export function resolveBundledChannelGatewayAuthBypassPaths(params: {
  channelId: string;
  cfg: OpenClawConfig;
}): string[] {
  const api = loadBundledChannelGatewayAuthApi(params.channelId);
  const paths = api?.resolveGatewayAuthBypassPaths?.({ cfg: params.cfg }) ?? [];
  return paths.flatMap((path) => (typeof path === "string" && path.trim() ? [path.trim()] : []));
}

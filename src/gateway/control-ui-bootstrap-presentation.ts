import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "./auth.js";
import type { ControlUiBootstrapConfig } from "./control-ui-bootstrap-contract.js";
import { isCloudflareAccessTrustedProxyAuth } from "./github-user-identity.js";

/** Public presentation settings of the Gateway serving the UI, never model permissions. */
export function resolveControlUiBootstrapPresentation(
  config: OpenClawConfig | undefined,
  authMethod?: GatewayAuthResult["method"],
  auth?: ResolvedGatewayAuth,
) {
  return {
    embedSandbox:
      config?.gateway?.controlUi?.embedSandbox === "trusted"
        ? "trusted"
        : config?.gateway?.controlUi?.embedSandbox === "strict"
          ? "strict"
          : "scripts",
    allowExternalEmbedUrls: config?.gateway?.controlUi?.allowExternalEmbedUrls === true,
    automaticallyFetchFavicons: config?.gateway?.controlUi?.automaticallyFetchFavicons !== false,
    seamColor: config?.ui?.seamColor,
    environment: config?.gateway?.controlUi?.environment,
    communityInvite: config?.gateway?.controlUi?.communityInvite !== false,
    newSessionModelDefaults: config?.gateway?.controlUi?.newSessionModelDefaults ?? "last-used",
    uploadsEnabled: config?.gateway?.uploads?.enabled !== false,
    logout:
      authMethod === "trusted-proxy" && isCloudflareAccessTrustedProxyAuth(auth)
        ? { provider: "cloudflare-access", path: "/cdn-cgi/access/logout" }
        : undefined,
  } satisfies Partial<ControlUiBootstrapConfig>;
}

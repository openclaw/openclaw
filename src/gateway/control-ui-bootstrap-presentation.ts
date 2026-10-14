import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ControlUiBootstrapConfig } from "./control-ui-bootstrap-contract.js";

/** Public presentation settings of the Gateway serving the UI, never model permissions. */
export function resolveControlUiBootstrapPresentation(config: OpenClawConfig | undefined) {
  return {
    embedSandbox: config?.gateway?.controlUi?.embedSandbox ?? "scripts",
    allowExternalEmbedUrls: config?.gateway?.controlUi?.allowExternalEmbedUrls === true,
    automaticallyFetchFavicons: config?.gateway?.controlUi?.automaticallyFetchFavicons !== false,
    seamColor: config?.ui?.seamColor,
    environment: config?.gateway?.controlUi?.environment,
    chatBubblesEnabled: config?.gateway?.controlUi?.experimental?.chatBubbles === true,
    communityInvite: config?.gateway?.controlUi?.communityInvite !== false,
    newSessionModelDefaults: config?.gateway?.controlUi?.newSessionModelDefaults ?? "last-used",
    uploadsEnabled: config?.gateway?.uploads?.enabled !== false,
  } satisfies Partial<ControlUiBootstrapConfig>;
}

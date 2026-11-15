import { resolveIsConfigReadOnly } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isOpenClawIdEnabled } from "../shared/openclaw-id-policy.js";
import type { ControlUiBootstrapConfig } from "./control-ui-bootstrap-contract.js";

/** Public presentation settings of the Gateway serving the UI, never model permissions. */
export function resolveControlUiBootstrapPresentation(config: OpenClawConfig | undefined) {
  const configReadOnly = resolveIsConfigReadOnly();
  return {
    ...(isOpenClawIdEnabled(config?.gateway?.openclawId) ? { openclawIdEnabled: true } : {}),
    embedSandbox: config?.gateway?.controlUi?.embedSandbox ?? "scripts",
    allowExternalEmbedUrls: config?.gateway?.controlUi?.allowExternalEmbedUrls === true,
    automaticallyFetchFavicons: config?.gateway?.controlUi?.automaticallyFetchFavicons !== false,
    seamColor: config?.ui?.seamColor,
    environment: config?.gateway?.controlUi?.environment,
    configReadOnly,
    configReadOnlyNotice: configReadOnly
      ? process.env.OPENCLAW_CONFIG_READONLY_NOTICE?.trim() || undefined
      : undefined,
    chatBubblesEnabled: config?.gateway?.controlUi?.experimental?.chatBubbles === true,
    composerPredictionsEnabled:
      config?.gateway?.controlUi?.experimental?.composerPredictions?.enabled === true,
    communityInvite: config?.gateway?.controlUi?.communityInvite !== false,
    newSessionModelDefaults: config?.gateway?.controlUi?.newSessionModelDefaults ?? "last-used",
    uploadsEnabled: config?.gateway?.uploads?.enabled !== false,
  } satisfies Partial<ControlUiBootstrapConfig>;
}

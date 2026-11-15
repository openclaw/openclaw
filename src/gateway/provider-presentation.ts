import { createHash } from "node:crypto";
import type { ProviderPresentation } from "../../packages/gateway-protocol/src/schema/model-catalog.js";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildControlUiResourcePath } from "./control-ui-resource-routes.js";

export function providerIconFingerprint(icon: NonNullable<ModelProviderConfig["icon"]>): string {
  return createHash("sha256").update(JSON.stringify(icon)).digest("hex").slice(0, 16);
}

/** Gateway projection only: presentation never enters inference identities or model references. */
export function resolveProviderPresentation(
  cfg: OpenClawConfig,
  providerId: string,
): ProviderPresentation {
  const provider = resolveMergedModelProviderConfig(cfg, providerId);
  const icon = provider?.icon;
  return {
    ...(provider?.name ? { providerName: provider.name } : {}),
    ...(icon
      ? {
          providerIcon:
            icon.source === "builtin"
              ? icon
              : {
                  source: "asset" as const,
                  url:
                    buildControlUiResourcePath("providerIcon", undefined, providerId) +
                    "?v=" +
                    providerIconFingerprint(icon),
                },
        }
      : {}),
  };
}

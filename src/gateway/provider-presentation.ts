import { createHash } from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ProviderPresentation } from "../../packages/gateway-protocol/src/schema/model-catalog.js";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { buildControlUiResourcePath } from "./control-ui-resource-routes.js";

export function providerIconFingerprint(icon: NonNullable<ModelProviderConfig["icon"]>): string {
  return createHash("sha256").update(JSON.stringify(icon)).digest("hex").slice(0, 16);
}

/**
 * Gateway projection only: presentation never enters inference identities or model references.
 * The user's configured provider name wins; otherwise the provider plugin's declared label.
 */
export function resolveProviderPresentation(
  cfg: OpenClawConfig,
  providerId: string,
  pluginRegistry?: Pick<PluginRegistry, "providers">,
): ProviderPresentation {
  const provider = resolveMergedModelProviderConfig(cfg, providerId);
  const icon = provider?.icon;
  const providerName =
    provider?.name ||
    pluginRegistry?.providers
      .find((entry) => normalizeProviderId(entry.provider.id) === providerId)
      ?.provider.label.trim();
  return {
    ...(providerName ? { providerName } : {}),
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

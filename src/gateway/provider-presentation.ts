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
 * Each provider plugin's declared label by provider id. Catalog rows carry it as `providerName`;
 * `resolveProviderPresentation`'s configured name replaces it.
 */
export function readDeclaredProviderNames(
  pluginRegistry: Pick<PluginRegistry, "providers"> | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const { provider } of pluginRegistry?.providers ?? []) {
    const label = provider.label.trim();
    if (label) {
      names.set(normalizeProviderId(provider.id), label);
    }
  }
  return names;
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

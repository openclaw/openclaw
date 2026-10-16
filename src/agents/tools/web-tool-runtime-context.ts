import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveManifestContractOwnerPluginId } from "../../plugins/plugin-registry.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { getActiveRuntimeWebToolsMetadataFromState } from "../../secrets/runtime-web-tools-state.js";
import type { RuntimeWebToolsMetadata } from "../../secrets/runtime-web-tools.types.js";

type WebProviderKind = "fetch" | "search";

export function resolveWebToolRuntimeContext<Kind extends WebProviderKind>(params: {
  config?: OpenClawConfig;
  runtimeMetadata?: RuntimeWebToolsMetadata[Kind];
  kind: Kind;
  lateBindRuntimeConfig?: boolean;
}) {
  const activeWebTools =
    params.lateBindRuntimeConfig === true ? getActiveRuntimeWebToolsMetadataFromState() : null;
  // Late-bound metadata wins over constructor-captured metadata for long-lived tool instances.
  const runtimeMetadata = activeWebTools?.[params.kind] ?? params.runtimeMetadata;
  const config =
    params.lateBindRuntimeConfig === true
      ? (getActiveSecretsRuntimeConfigSnapshot()?.config ?? params.config)
      : params.config;
  let providerSelectionId =
    (runtimeMetadata?.selectedProvider ?? runtimeMetadata?.providerConfigured) || "";
  if (!providerSelectionId) {
    const configuredProvider = config?.tools?.web?.[params.kind]?.provider;
    providerSelectionId =
      typeof configuredProvider === "string" ? configuredProvider.trim().toLowerCase() : "";
  }
  return {
    config,
    // Search uses the live registry; only fetch routes bundled selections by manifest ownership.
    preferRuntimeProviders:
      !providerSelectionId ||
      params.kind === "search" ||
      !resolveManifestContractOwnerPluginId({
        contract: "webFetchProviders",
        value: providerSelectionId,
        origin: "bundled",
        config,
      }),
    providerSelectionId,
    runtimeMetadata,
  };
}

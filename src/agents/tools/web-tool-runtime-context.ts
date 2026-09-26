/**
 * Late-bound runtime context for web fetch/search tools.
 *
 * Resolves active secrets/runtime provider metadata for long-lived tool instances.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveManifestContractOwnerPluginId } from "../../plugins/plugin-registry.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { getActiveRuntimeWebToolsMetadataFromState } from "../../secrets/runtime-web-tools-state.js";
import type {
  RuntimeWebFetchMetadata,
  RuntimeWebSearchMetadata,
} from "../../secrets/runtime-web-tools.types.js";

type WebProviderKind = "fetch" | "search";

type WebProviderRuntimeMetadata = RuntimeWebFetchMetadata | RuntimeWebSearchMetadata;

type ResolvedWebToolRuntimeContext<TMetadata extends WebProviderRuntimeMetadata> = {
  config?: OpenClawConfig;
  preferRuntimeProviders: boolean;
  providerSelectionId: string;
  runtimeMetadata?: TMetadata;
};

function resolveWebToolRuntimeContext<TMetadata extends WebProviderRuntimeMetadata>(params: {
  capturedConfig?: OpenClawConfig;
  capturedRuntimeMetadata?: TMetadata;
  kind: WebProviderKind;
  lateBindRuntimeConfig?: boolean;
}): ResolvedWebToolRuntimeContext<TMetadata> {
  const activeWebTools =
    params.lateBindRuntimeConfig === true ? getActiveRuntimeWebToolsMetadataFromState() : null;
  // Late-bound metadata wins over constructor-captured metadata for long-lived tool instances.
  const runtimeMetadata = (activeWebTools?.[params.kind] ?? params.capturedRuntimeMetadata) as
    | TMetadata
    | undefined;
  const config =
    params.lateBindRuntimeConfig === true
      ? (getActiveSecretsRuntimeConfigSnapshot()?.config ?? params.capturedConfig)
      : params.capturedConfig;
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

/** Resolves runtime provider context for the web_search tool. */
export function resolveWebSearchToolRuntimeContext(params: {
  config?: OpenClawConfig;
  lateBindRuntimeConfig?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}) {
  const { runtimeMetadata, ...resolved } = resolveWebToolRuntimeContext({
    capturedConfig: params.config,
    capturedRuntimeMetadata: params.runtimeWebSearch,
    kind: "search",
    lateBindRuntimeConfig: params.lateBindRuntimeConfig,
  });
  return {
    ...resolved,
    runtimeWebSearch: runtimeMetadata,
  };
}

/** Resolves runtime provider context for the web_fetch tool. */
export function resolveWebFetchToolRuntimeContext(params: {
  config?: OpenClawConfig;
  lateBindRuntimeConfig?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
}) {
  const { runtimeMetadata, ...resolved } = resolveWebToolRuntimeContext({
    capturedConfig: params.config,
    capturedRuntimeMetadata: params.runtimeWebFetch,
    kind: "fetch",
    lateBindRuntimeConfig: params.lateBindRuntimeConfig,
  });
  return {
    ...resolved,
    runtimeWebFetch: runtimeMetadata,
  };
}

import type { PluginCredentialDescriptor } from "../../packages/gateway-protocol/src/schema/plugin-credentials.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseConcreteConfigPathTokens } from "../shared/dot-path.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";
import {
  resolveBundledWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";
import type { WebSearchProviderPlugin } from "./web-provider-types.js";
import { resolveWebSearchInstallCatalogEntries } from "./web-search-install-catalog.js";

type CredentialMetadata = Pick<
  WebSearchProviderPlugin,
  | "credentialPath"
  | "credentialLabel"
  | "envVars"
  | "placeholder"
  | "signupUrl"
  | "requiresCredential"
>;

function projectPluginCredentialDescriptors(
  pluginId: string,
  providers: readonly CredentialMetadata[],
): PluginCredentialDescriptor[] {
  const fields = new Map<string, PluginCredentialDescriptor>();
  for (const provider of providers) {
    if (!provider.credentialPath || !provider.credentialLabel) {
      continue;
    }
    let path: Array<string | number>;
    try {
      path = parseConcreteConfigPathTokens(provider.credentialPath);
    } catch {
      continue;
    }
    if (
      path.length < 5 ||
      path.length > 32 ||
      path[0] !== "plugins" ||
      path[1] !== "entries" ||
      path[2] !== pluginId ||
      path[3] !== "config"
    ) {
      continue;
    }
    const key = JSON.stringify(path);
    if (fields.has(key)) {
      continue;
    }
    const signupUrl =
      provider.signupUrl &&
      URL.canParse(provider.signupUrl) &&
      ["https:", "http:"].includes(new URL(provider.signupUrl).protocol)
        ? provider.signupUrl
        : undefined;
    fields.set(key, {
      path,
      label: provider.credentialLabel,
      envVars: [...provider.envVars],
      ...(provider.placeholder ? { placeholder: provider.placeholder } : {}),
      ...(signupUrl ? { signupUrl } : {}),
      ...(provider.requiresCredential !== undefined
        ? { requiresCredential: provider.requiresCredential }
        : {}),
    });
  }
  return [...fields.values()];
}

/** Metadata inspection must never enable or activate a plugin to discover a key field. */
export function resolvePluginCredentialDescriptors(
  config: OpenClawConfig,
  manifest: PluginManifestRecord,
): PluginCredentialDescriptor[] {
  const registry = getPluginRegistryForContext();
  const providers: CredentialMetadata[] = [
    ...(registry?.webSearchProviders ?? []),
    ...(registry?.webFetchProviders ?? []),
  ]
    .filter((entry) => entry.pluginId === manifest.id)
    .map((entry) => entry.provider);
  if (manifest.origin === "bundled") {
    const scope = { config, onlyPluginIds: [manifest.id], manifestRecords: [manifest] };
    if (manifest.contracts?.webSearchProviders?.length) {
      providers.push(...(resolveBundledWebSearchProvidersFromPublicArtifacts(scope) ?? []));
    }
    if (manifest.contracts?.webFetchProviders?.length) {
      providers.push(...(resolveBundledWebFetchProvidersFromPublicArtifacts(scope) ?? []));
    }
  } else if (manifest.trustedOfficialInstall) {
    providers.push(
      ...resolveWebSearchInstallCatalogEntries()
        .filter((entry) => entry.pluginId === manifest.id)
        .map((entry) => entry.provider),
    );
  }
  return projectPluginCredentialDescriptors(manifest.id, providers);
}

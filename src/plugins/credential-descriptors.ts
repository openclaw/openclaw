import type { PluginCredentialDescriptor } from "../../packages/gateway-protocol/src/schema/plugin-credentials.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { parseConcreteConfigPathTokens } from "../shared/dot-path.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";
import {
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.explicit.js";
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
    // Settings inspect installed metadata independently of runtime enablement/allowlists.
    const scope = { onlyPluginIds: [manifest.id] };
    if (manifest.contracts?.webSearchProviders?.length) {
      providers.push(...(resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(scope) ?? []));
    }
    if (manifest.contracts?.webFetchProviders?.length) {
      providers.push(...(resolveBundledExplicitWebFetchProvidersFromPublicArtifacts(scope) ?? []));
    }
  } else if (manifest.trustedOfficialInstall) {
    providers.push(
      ...resolveWebSearchInstallCatalogEntries()
        .filter((entry) => entry.pluginId === manifest.id)
        .map((entry) => entry.provider),
    );
  }
  const fields = new Map(
    projectPluginCredentialDescriptors(manifest.id, providers).map((field) => [
      JSON.stringify(field.path),
      field,
    ]),
  );
  for (const input of manifest.configContracts?.secretInputs?.paths ?? []) {
    if (input.ownerKind !== "capability" || input.expected !== "string") {
      continue;
    }
    // Config contracts use dot-separated segments, not the richer authoring
    // field-path grammar. Do not reinterpret brackets or expand wildcard owners.
    const segments = input.path.split(".");
    if (
      segments.some(
        (part) =>
          !part ||
          part !== part.trim() ||
          part.includes("*") ||
          part.includes("[") ||
          part.includes("]") ||
          isBlockedObjectKey(part),
      )
    ) {
      continue;
    }
    const path = ["plugins", "entries", manifest.id, "config", ...segments];
    if (path.length > 32 || path.some((part) => part.length > 512)) {
      continue;
    }
    const key = JSON.stringify(path);
    const existing = fields.get(key);
    const hint = manifest.configUiHints?.[input.path];
    const label = existing?.label ?? hint?.label ?? input.path;
    const placeholder = existing?.placeholder ?? hint?.placeholder;
    fields.set(key, {
      ...existing,
      path,
      label: label.trim() ? label.slice(0, 512) : input.path.slice(0, 512),
      envVars: existing?.envVars ?? [],
      ...(placeholder ? { placeholder: placeholder.slice(0, 512) } : {}),
      storage: "protected",
    });
  }
  return [...fields.values()];
}

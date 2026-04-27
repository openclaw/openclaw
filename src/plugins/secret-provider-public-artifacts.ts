import {
  loadBundledPluginPublicArtifactModuleSync,
  resolveBundledPluginPublicArtifactPath,
} from "./public-surface-loader.js";
import type { PluginSecretProviderEntry, SecretProviderPlugin } from "./secret-provider-types.js";

const SECRET_PROVIDER_ARTIFACT_CANDIDATES = [
  "secret-provider.js",
  "secret-provider-api.js",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretProviderPlugin(value: unknown): value is SecretProviderPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.label === "string" &&
    typeof value.resolve === "function" &&
    (value.validateConfig === undefined || typeof value.validateConfig === "function")
  );
}

function tryLoadBundledPublicArtifactModule(params: {
  dirName: string;
}): Record<string, unknown> | null {
  for (const artifactBasename of SECRET_PROVIDER_ARTIFACT_CANDIDATES) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: params.dirName,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function collectProviderFactories(mod: Record<string, unknown>): {
  providers: SecretProviderPlugin[];
  errors: unknown[];
} {
  const providers: SecretProviderPlugin[] = [];
  const errors: unknown[] = [];
  for (const [name, exported] of Object.entries(mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith("SecretProvider")
    ) {
      continue;
    }
    let candidate: unknown;
    try {
      candidate = exported();
    } catch (error) {
      errors.push(error);
      continue;
    }
    if (isSecretProviderPlugin(candidate)) {
      providers.push(candidate);
    }
  }
  return { providers, errors };
}

export function loadBundledSecretProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginSecretProviderEntry[] | null {
  const mod = tryLoadBundledPublicArtifactModule({ dirName: params.dirName });
  if (!mod) {
    return null;
  }
  const { providers, errors } = collectProviderFactories(mod);
  if (providers.length === 0) {
    if (errors.length > 0) {
      throw new Error(`Unable to initialize secret providers for plugin ${params.pluginId}`, {
        cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
      });
    }
    return null;
  }
  // Surface partial-success factory errors so plugin authors aren't left
  // wondering why a sibling factory silently went missing. We only warn (rather
  // than throw) because the valid providers from this plugin are still usable.
  if (errors.length > 0) {
    const cause = errors.length === 1 ? errors[0] : new AggregateError(errors);
    const message = cause instanceof Error ? cause.message : String(cause);
    console.warn(
      `[plugin:${params.pluginId}] One or more secret provider factories failed to initialize and were skipped: ${message}`,
    );
  }
  return providers.map((provider) => Object.assign({}, provider, { pluginId: params.pluginId }));
}

export function hasBundledSecretProviderPublicArtifact(pluginId: string): boolean {
  return SECRET_PROVIDER_ARTIFACT_CANDIDATES.some((artifactBasename) =>
    Boolean(resolveBundledPluginPublicArtifactPath({ dirName: pluginId, artifactBasename })),
  );
}

import { hasAnthropicDefaultSignal } from "./defaults.js";
import type {
  ConfigSnapshotMetadataLoader,
  ConfigSnapshotPreparationContext,
  MaterializationRequest,
  MetadataRequest,
  PreparedValidation,
  ValidationRequest,
} from "./io.snapshot-preparation.types.js";
import { materializeRuntimeConfig } from "./materialize.js";
import type { OpenClawConfig, RuntimeConfig } from "./types.js";
import {
  validateConfigObjectWithPluginsAsync,
  validateConfigObjectWithStrictFactsAsync,
} from "./validation.js";
import type { PreparedConfigValidationPluginMetadata } from "./validation.types.js";

/** Preserve the ordinary reader's lazy defaults, including an unused manifest loader. */
export function materializeConfigSnapshotDefaults(
  context: ConfigSnapshotPreparationContext,
  config: OpenClawConfig,
  metadata: ConfigSnapshotMetadataLoader,
): RuntimeConfig {
  return materializeRuntimeConfig(config, {
    ...context.pathResolution,
    ...(context.options.pluginValidation === "core-only"
      ? { manifestRegistry: { plugins: [] } }
      : { loadManifestRegistry: () => metadata.load(config).manifestRegistry }),
  });
}

/** Supplied by a native Gateway host, never selected by generic config readers. */
export function prepareHostConfigSnapshot(request: ValidationRequest): Promise<PreparedValidation>;
export function prepareHostConfigSnapshot(request: MaterializationRequest): Promise<RuntimeConfig>;
export function prepareHostConfigSnapshot(
  request: MetadataRequest,
): Promise<PreparedConfigValidationPluginMetadata>;
export async function prepareHostConfigSnapshot(
  request: ValidationRequest | MaterializationRequest | MetadataRequest,
): Promise<PreparedValidation | RuntimeConfig | PreparedConfigValidationPluginMetadata> {
  if (request.kind === "metadata") {
    return await request.metadata.loadAsync(request.config);
  }
  const { context, metadata } = request;
  if (request.kind === "materialize") {
    if (
      context.options.pluginValidation !== "core-only" &&
      (request.config.models?.providers ||
        hasAnthropicDefaultSignal(request.config, context.deps.env))
    ) {
      await metadata.loadAsync(request.config);
    }
    return materializeConfigSnapshotDefaults(context, request.config, metadata);
  }
  return prepareConfigSnapshotValidation(request);
}

/** Both explicit CLI validation and an admitted host read prepare database facts before validation. */
export async function prepareConfigSnapshotValidation(
  request: ValidationRequest,
): Promise<PreparedValidation> {
  const { context, metadata } = request;
  const pending = await context.resolveDeferredPluginMigrationsAsync();
  const validate =
    request.prepareValidation === "strict"
      ? validateConfigObjectWithStrictFactsAsync
      : validateConfigObjectWithPluginsAsync;
  return {
    deferredPluginMigrations: pending,
    validated: await validate(request.raw, {
      schemaValidation: "runtime",
      ...context.pathResolution,
      pluginValidation: context.options.pluginValidation,
      loadPluginMetadataSnapshotAsync: metadata.loadAsync,
      sourceRaw: request.sourceRaw,
      preservedLegacyRootKeys: context.options.preservedLegacyRootKeys,
      deferredPluginMigrations: pending,
    }),
  };
}

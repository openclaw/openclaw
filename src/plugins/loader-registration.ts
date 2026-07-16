import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shouldLoadChannelPluginInSetupRuntime } from "./loader-channel-setup.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import type { OpenClawPluginDefinition, PluginRegistrationMode } from "./types.js";

export class PluginLoadFailureError extends Error {
  readonly pluginIds: string[];
  readonly registry: PluginRegistry;

  constructor(registry: PluginRegistry) {
    const failedPlugins = registry.plugins.filter((entry) => entry.status === "error");
    const summary = failedPlugins
      .map((entry) => `${entry.id}: ${entry.error ?? "unknown plugin load error"}`)
      .join("; ");
    super(`plugin load failed: ${summary}`);
    this.name = "PluginLoadFailureError";
    this.pluginIds = failedPlugins.map((entry) => entry.id);
    this.registry = registry;
  }
}

export type PluginRegistrationPlan = {
  /** Public compatibility label passed to plugin register(api). */
  mode: PluginRegistrationMode;
  /** Load a setup entry instead of the normal runtime entry. */
  loadSetupEntry: boolean;
  /** Setup flow also needs the runtime channel entry for runtime setters/plugin shape. */
  loadSetupRuntimeEntry: boolean;
  /** Apply runtime capability policy such as memory-slot selection. */
  runRuntimeCapabilityPolicy: boolean;
  /** Register metadata that only belongs to live activation, not discovery snapshots. */
  runFullActivationOnlyRegistrations: boolean;
};

/** Convert loader intent into explicit entrypoint and activation behavior. */
export function resolvePluginRegistrationPlan(params: {
  canLoadScopedSetupOnlyChannelPlugin: boolean;
  scopedSetupOnlyChannelPluginRequested: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins: boolean;
  enableStateEnabled: boolean;
  shouldLoadModules: boolean;
  validateOnly: boolean;
  shouldActivate: boolean;
  manifestRecord: PluginManifestRecord;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  preferSetupRuntimeForChannelPlugins: boolean;
  forceFullRuntimeForChannelPlugins: boolean;
  toolDiscovery: boolean;
}): PluginRegistrationPlan | null {
  if (params.canLoadScopedSetupOnlyChannelPlugin) {
    return {
      mode: "setup-only",
      loadSetupEntry: true,
      loadSetupRuntimeEntry: false,
      runRuntimeCapabilityPolicy: false,
      runFullActivationOnlyRegistrations: false,
    };
  }
  if (
    params.scopedSetupOnlyChannelPluginRequested &&
    params.requireSetupEntryForSetupOnlyChannelPlugins
  ) {
    return null;
  }
  if (!params.enableStateEnabled) {
    return null;
  }
  if (params.toolDiscovery) {
    return {
      mode: "tool-discovery",
      loadSetupEntry: false,
      loadSetupRuntimeEntry: false,
      runRuntimeCapabilityPolicy: true,
      runFullActivationOnlyRegistrations: false,
    };
  }
  const loadSetupRuntimeEntry =
    !params.forceFullRuntimeForChannelPlugins &&
    params.shouldLoadModules &&
    !params.validateOnly &&
    shouldLoadChannelPluginInSetupRuntime({
      manifestChannels: params.manifestRecord.channels,
      setupSource: params.manifestRecord.setupSource,
      startupDeferConfiguredChannelFullLoadUntilAfterListen:
        params.manifestRecord.startupDeferConfiguredChannelFullLoadUntilAfterListen,
      cfg: params.cfg,
      env: params.env,
      preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
    });
  if (loadSetupRuntimeEntry) {
    return {
      mode: "setup-runtime",
      loadSetupEntry: true,
      loadSetupRuntimeEntry: true,
      runRuntimeCapabilityPolicy: false,
      runFullActivationOnlyRegistrations: false,
    };
  }
  const mode = params.shouldActivate ? "full" : "discovery";
  return {
    mode,
    loadSetupEntry: false,
    loadSetupRuntimeEntry: false,
    runRuntimeCapabilityPolicy: true,
    runFullActivationOnlyRegistrations: mode === "full",
  };
}

export function applyManifestSnapshotMetadata(
  record: PluginRecord,
  manifestRecord: PluginManifestRecord,
): void {
  record.channelIds = [...(manifestRecord.channels ?? [])];
  record.providerIds = [...(manifestRecord.providers ?? [])];
  record.cliBackendIds = [
    ...(manifestRecord.cliBackends ?? []),
    ...(manifestRecord.setup?.cliBackends ?? []),
  ];
  record.commands = (manifestRecord.commandAliases ?? []).map((alias) => alias.name);
}

export function validatePluginConfig(params: {
  schema?: Record<string, unknown>;
  cacheKey?: string;
  value?: unknown;
}): Result<Record<string, unknown> | undefined, string[]> {
  const { schema, value } = params;
  if (!schema) {
    return ok(value as Record<string, unknown> | undefined);
  }
  if (isEmptyPluginConfigJsonSchema(schema)) {
    if (
      value === undefined ||
      (value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    ) {
      return ok({});
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return resultError(["<root>: must be object"]);
    }
    return resultError(["<root>: config must be empty"]);
  }
  const result = validateJsonSchemaValue({
    schema,
    cacheKey: params.cacheKey ?? JSON.stringify(schema),
    value: value ?? {},
    applyDefaults: true,
  });
  return result.ok
    ? ok(result.value as Record<string, unknown> | undefined)
    : resultError(result.errors.map((error) => error.text));
}

function isEmptyPluginConfigJsonSchema(schema: Record<string, unknown>): boolean {
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    return false;
  }
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties) ||
    Object.keys(properties).length > 0
  ) {
    return false;
  }
  return !(
    "required" in schema ||
    "dependentRequired" in schema ||
    "dependencies" in schema ||
    "minProperties" in schema ||
    "allOf" in schema ||
    "anyOf" in schema ||
    "oneOf" in schema ||
    "not" in schema
  );
}

export function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const seen = new Set<unknown>();
  const candidates: unknown[] = [unwrapDefaultModuleExport(moduleExport), moduleExport];
  for (let index = 0; index < candidates.length && index < 12; index += 1) {
    const resolved = candidates[index];
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    if (typeof resolved === "function") {
      return { register: resolved as OpenClawPluginDefinition["register"] };
    }
    if (resolved && typeof resolved === "object") {
      const definition = resolved as OpenClawPluginDefinition;
      const register = definition.register ?? definition.activate;
      if (typeof register === "function") {
        return { definition, register };
      }
      for (const key of ["default", "module"]) {
        if (key in definition) {
          candidates.push((definition as Record<string, unknown>)[key]);
        }
      }
    }
  }
  const resolved = candidates[0];
  if (typeof resolved === "function") {
    return { register: resolved as OpenClawPluginDefinition["register"] };
  }
  if (resolved && typeof resolved === "object") {
    const definition = resolved as OpenClawPluginDefinition;
    return { definition, register: definition.register ?? definition.activate };
  }
  return {};
}

function kindIncludes(kind: unknown, target: string): boolean {
  return kind === target || (Array.isArray(kind) && kind.includes(target));
}

export function formatBundledChannelWrongLoaderError(kind: unknown): string | null {
  if (kindIncludes(kind, "bundled-channel-setup-entry")) {
    return "bundled channel setup entry requires setup-runtime loader";
  }
  if (kindIncludes(kind, "bundled-channel-entry")) {
    return "bundled channel entry requires setup-runtime loader";
  }
  return null;
}

export function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]): void {
  diagnostics.push(...append);
}

export function pushPluginValidationError(params: {
  registry: PluginRegistry;
  seenIds: Map<string, PluginRecord["origin"]>;
  pluginId: string;
  origin: PluginRecord["origin"];
  record: PluginRecord;
  message: string;
}): void {
  params.record.status = "error";
  params.record.error = params.message;
  params.record.failedAt = new Date();
  params.record.failurePhase = "validation";
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.pluginId, params.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: params.record.error,
  });
}

export function maybeThrowOnPluginLoadError(
  registry: PluginRegistry,
  throwOnLoadError: boolean | undefined,
): void {
  if (throwOnLoadError && registry.plugins.some((entry) => entry.status === "error")) {
    throw new PluginLoadFailureError(registry);
  }
}

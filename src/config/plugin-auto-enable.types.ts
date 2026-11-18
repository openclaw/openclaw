import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.types.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.types.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Reasons a configured surface can cause a plugin to be auto-enabled. */
export type PluginAutoEnableCandidate = { pluginId: string } & (
  | {
      kind: "channel-configured";
      channelId: string;
    }
  | {
      kind:
        | "provider-auth-configured"
        | "speech-provider-selected"
        | "worker-provider-selected"
        | "storage-provider-selected"
        | "decision-provider-selected"
        | "web-search-provider-selected"
        | "web-fetch-provider-selected";
      providerId: string;
    }
  | {
      kind: "provider-model-configured";
      modelRef: string;
    }
  | {
      kind: "agent-harness-runtime-configured";
      runtime: string;
    }
  | {
      kind:
        | "plugin-web-search-configured"
        | "plugin-web-fetch-configured"
        | "plugin-tool-configured"
        | "configured-plugin-repaired";
    }
  | {
      kind: "setup-auto-enable";
      reason: string;
    }
);

export type PluginAutoEnableResult = {
  config: OpenClawConfig;
  changes: string[];
  autoEnabledReasons: Record<string, string[]>;
};

type PluginAutoEnableCacheEntry = {
  capturedConfig: OpenClawConfig | undefined;
  candidates: PluginDiscoveryResult["candidates"] | undefined;
  plugins: PluginManifestRegistry["plugins"];
  ambientEnvTriggers: AmbientEnvTriggerPolicy;
  result: PluginAutoEnableResult;
};
export type PluginAutoEnableDiscoveryCache = WeakMap<object, PluginAutoEnableCacheEntry>;
type PluginAutoEnableRegistryCache = WeakMap<object, PluginAutoEnableDiscoveryCache>;
type PluginAutoEnableEnvCache = WeakMap<object, PluginAutoEnableRegistryCache>;
export type PluginAutoEnableConfigCache = WeakMap<object, PluginAutoEnableEnvCache>;

/** The plugin runtime owner supplies generation identities; config policy never discovers them. */
export type PluginAutoEnableRuntimePreparation = {
  capturedConfig: OpenClawConfig;
  cache: PluginAutoEnableConfigCache;
  metadataKey: object;
  envKey: object;
};

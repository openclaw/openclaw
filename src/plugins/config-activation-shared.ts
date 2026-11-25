import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveChannelConfigEnablement,
  type NormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

type PluginKindLike = string | readonly string[] | undefined;

export type PluginActivationSource = "disabled" | "explicit" | "auto" | "default";

export type PluginActivationStateLike = {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  reason?: string;
};

export type PluginActivationConfigSourceLike = {
  plugins: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
};

export function resolvePluginActivationStateShared(params: {
  id: string;
  origin: string;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSourceLike;
  autoEnabledReason?: string;
  allowBundledChannelExplicitBypassesAllowlist?: boolean;
  /** Manifest-owned channel ids; the plugin id alone cannot resolve `channels.<id>` for every owner. */
  channelIds?: readonly string[];
}): PluginActivationStateLike {
  const activationSource = params.activationSource ?? {
    plugins: params.config,
    rootConfig: params.rootConfig,
  };
  const explicitPolicyId = normalizePluginPolicyId(params.id);
  let explicitReason: string | undefined;
  if (activationSource.plugins.entries[explicitPolicyId]?.enabled === true) {
    explicitReason = "enabled in config";
  } else if (
    params.origin === "bundled" &&
    resolveChannelConfigEnablement(activationSource.rootConfig, params.id, params.channelIds) ===
      true
  ) {
    explicitReason = "channel enabled in config";
  } else if (activationSource.plugins.slots.memory === params.id) {
    explicitReason = "selected memory slot";
  } else if (
    activationSource.plugins.contextEngineOwnerId !== undefined
      ? activationSource.plugins.contextEngineOwnerId === explicitPolicyId
      : activationSource.plugins.slots.contextEngine === params.id
  ) {
    explicitReason = "selected context engine slot";
  } else if (
    params.origin !== "bundled" &&
    activationSource.plugins.allow.includes(explicitPolicyId)
  ) {
    explicitReason = "selected in allowlist";
  }

  // Keep result construction shared; policy precedence stays in the ordered branches below.
  const decision = (
    source: PluginActivationSource,
    details: Partial<Pick<PluginActivationStateLike, "explicitlyEnabled" | "reason">> = {},
  ): PluginActivationStateLike => ({
    enabled: source !== "disabled",
    activated: source !== "disabled",
    explicitlyEnabled: explicitReason !== undefined,
    source,
    reason: undefined,
    ...details,
  });

  if (!params.config.enabled) {
    return decision("disabled", { reason: "plugins disabled" });
  }
  const policyId = normalizePluginPolicyId(params.id);
  if (params.config.deny.includes(policyId)) {
    return decision("disabled", { reason: "blocked by denylist" });
  }
  const entry = params.config.entries[policyId];
  if (entry?.enabled === false) {
    return decision("disabled", { reason: "disabled in config" });
  }
  // An owner-wide channel disable wins over plugin enablement left by install/enable flows.
  // Enabled or unspecified sibling channels must still be able to load their shared plugin.
  if (
    resolveChannelConfigEnablement(
      activationSource.rootConfig ?? params.rootConfig,
      params.id,
      params.channelIds,
    ) === false
  ) {
    return decision("disabled", { reason: "channel disabled in config" });
  }
  const explicitlyAllowed = params.config.allow.includes(policyId);
  if (
    params.origin === "workspace" &&
    !explicitlyAllowed &&
    entry?.enabled !== true &&
    explicitReason !== "selected context engine slot"
  ) {
    return decision("disabled", { reason: "workspace plugin (disabled by default)" });
  }
  if (params.config.slots.memory === params.id) {
    return decision("explicit", { explicitlyEnabled: true, reason: "selected memory slot" });
  }
  if (
    params.config.contextEngineOwnerId !== undefined
      ? params.config.contextEngineOwnerId === policyId
      : params.config.slots.contextEngine === params.id
  ) {
    return decision("explicit", {
      explicitlyEnabled: true,
      reason: "selected context engine slot",
    });
  }
  if (
    params.allowBundledChannelExplicitBypassesAllowlist === true &&
    explicitReason === "channel enabled in config"
  ) {
    return decision("explicit", { explicitlyEnabled: true, reason: explicitReason });
  }
  if (params.config.allow.length > 0 && !explicitlyAllowed) {
    return decision("disabled", { reason: "not in allowlist" });
  }
  if (explicitReason) {
    return decision("explicit", { explicitlyEnabled: true, reason: explicitReason });
  }
  const autoEnabledReason =
    params.autoEnabledReason ||
    (entry?.enabled === true ? "enabled by effective config" : undefined) ||
    (params.origin === "bundled" &&
    resolveChannelConfigEnablement(params.rootConfig, params.id, params.channelIds) === true
      ? "channel configured"
      : undefined);
  // Only promote auto-enable to a bundled default when the authored policy permits it.
  if (
    params.origin === "bundled" &&
    params.enabledByDefault === true &&
    (!autoEnabledReason ||
      activationSource.plugins.allow.length === 0 ||
      activationSource.plugins.allow.includes(policyId))
  ) {
    return decision("default", { explicitlyEnabled: false, reason: "bundled default enablement" });
  }
  if (autoEnabledReason) {
    return decision("auto", { explicitlyEnabled: false, reason: autoEnabledReason });
  }
  if (params.origin === "bundled") {
    return decision("disabled", {
      explicitlyEnabled: false,
      reason: "bundled (disabled by default)",
    });
  }
  return decision("default");
}

export function resolveMemorySlotDecisionShared(params: {
  id: string;
  kind?: PluginKindLike;
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  if (!(Array.isArray(params.kind) ? params.kind.includes("memory") : params.kind === "memory")) {
    return { enabled: true };
  }
  // A dual-kind plugin (e.g. ["memory", "context-engine"]) that lost the
  // memory slot must stay enabled so its other slot role can still load.
  const isMultiKind = Array.isArray(params.kind) && params.kind.length > 1;
  if (params.slot === null) {
    return isMultiKind ? { enabled: true } : { enabled: false, reason: "memory slot disabled" };
  }
  if (typeof params.slot === "string") {
    if (params.slot === params.id) {
      return { enabled: true, selected: true };
    }
    return isMultiKind
      ? { enabled: true }
      : { enabled: false, reason: `memory slot set to "${params.slot}"` };
  }
  if (params.selectedId && params.selectedId !== params.id) {
    return isMultiKind
      ? { enabled: true }
      : { enabled: false, reason: `memory slot already filled by "${params.selectedId}"` };
  }
  return { enabled: true, selected: true };
}

// Shares plugin activation state helpers across config and registry code.
type EnableStateLike = {
  enabled: boolean;
  reason?: string;
};

type PluginKindLike = string | readonly string[] | undefined;

export type PluginActivationSource = "disabled" | "explicit" | "auto" | "default";

export type PluginExplicitSelectionCause =
  | "enabled-in-config"
  | "bundled-channel-enabled-in-config"
  | "selected-memory-slot"
  | "selected-context-engine-slot"
  | "selected-in-allowlist";

export type PluginActivationCause =
  | PluginExplicitSelectionCause
  | "plugins-disabled"
  | "blocked-by-denylist"
  | "disabled-in-config"
  | "workspace-disabled-by-default"
  | "selected-dreaming-sidecar"
  | "not-in-allowlist"
  | "enabled-by-effective-config"
  | "bundled-channel-configured"
  | "bundled-default-enablement"
  | "bundled-disabled-by-default";

export type PluginActivationStateLike = {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  reason?: string;
};

export type PluginActivationDecision = PluginActivationStateLike & {
  cause?: PluginActivationCause;
};

type PluginActivationConfigLike = {
  enabled: boolean;
  allow: readonly string[];
  deny: readonly string[];
  slots: {
    memory?: string | null;
    contextEngine?: string | null;
  };
  entries: Record<string, { enabled?: boolean } | undefined>;
};

export type PluginActivationConfigSourceLike<TRootConfig> = {
  plugins: PluginActivationConfigLike;
  rootConfig?: TRootConfig;
};

export const PLUGIN_ACTIVATION_REASON_BY_CAUSE: Record<PluginActivationCause, string> = {
  "enabled-in-config": "enabled in config",
  "bundled-channel-enabled-in-config": "channel enabled in config",
  "selected-memory-slot": "selected memory slot",
  "selected-context-engine-slot": "selected context engine slot",
  "selected-in-allowlist": "selected in allowlist",
  "plugins-disabled": "plugins disabled",
  "blocked-by-denylist": "blocked by denylist",
  "disabled-in-config": "disabled in config",
  "workspace-disabled-by-default": "workspace plugin (disabled by default)",
  "selected-dreaming-sidecar": "selected dreaming sidecar",
  "not-in-allowlist": "not in allowlist",
  "enabled-by-effective-config": "enabled by effective config",
  "bundled-channel-configured": "channel configured",
  "bundled-default-enablement": "bundled default enablement",
  "bundled-disabled-by-default": "bundled (disabled by default)",
};

export function resolvePluginActivationReason(
  cause?: PluginActivationCause,
  reason?: string,
): string | undefined {
  if (reason) {
    return reason;
  }
  return cause ? PLUGIN_ACTIVATION_REASON_BY_CAUSE[cause] : undefined;
}

export function toPluginActivationState(
  decision: PluginActivationDecision,
): PluginActivationStateLike {
  return {
    enabled: decision.enabled,
    activated: decision.activated,
    explicitlyEnabled: decision.explicitlyEnabled,
    source: decision.source,
    reason: resolvePluginActivationReason(decision.cause, decision.reason),
  };
}

function resolveExplicitPluginSelectionShared<TRootConfig>(params: {
  id: string;
  origin: string;
  config: PluginActivationConfigLike;
  rootConfig?: TRootConfig;
  isBundledChannelEnabledByChannelConfig: (
    rootConfig: TRootConfig | undefined,
    pluginId: string,
  ) => boolean;
}): { explicitlyEnabled: boolean; cause?: PluginExplicitSelectionCause } {
  if (params.config.entries[params.id]?.enabled === true) {
    return { explicitlyEnabled: true, cause: "enabled-in-config" };
  }
  if (
    params.origin === "bundled" &&
    params.isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return { explicitlyEnabled: true, cause: "bundled-channel-enabled-in-config" };
  }
  if (params.config.slots.memory === params.id) {
    return { explicitlyEnabled: true, cause: "selected-memory-slot" };
  }
  if (params.config.slots.contextEngine === params.id) {
    return { explicitlyEnabled: true, cause: "selected-context-engine-slot" };
  }
  if (params.origin !== "bundled" && params.config.allow.includes(params.id)) {
    return { explicitlyEnabled: true, cause: "selected-in-allowlist" };
  }
  return { explicitlyEnabled: false };
}

export function resolvePluginActivationDecisionShared<TRootConfig>(params: {
  id: string;
  origin: string;
  config: PluginActivationConfigLike;
  rootConfig?: TRootConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSourceLike<TRootConfig>;
  autoEnabledReason?: string;
  allowBundledChannelExplicitBypassesAllowlist?: boolean;
  isDreamingSidecar?: boolean;
  isBundledChannelEnabledByChannelConfig: (
    rootConfig: TRootConfig | undefined,
    pluginId: string,
  ) => boolean;
}): PluginActivationDecision {
  const activationSource = params.activationSource ?? {
    plugins: params.config,
    rootConfig: params.rootConfig,
  };
  const explicitSelection = resolveExplicitPluginSelectionShared({
    id: params.id,
    origin: params.origin,
    config: activationSource.plugins,
    rootConfig: activationSource.rootConfig,
    isBundledChannelEnabledByChannelConfig: params.isBundledChannelEnabledByChannelConfig,
  });

  if (!params.config.enabled) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "plugins-disabled",
    };
  }
  if (params.config.deny.includes(params.id)) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "blocked-by-denylist",
    };
  }
  const entry = params.config.entries[params.id];
  if (entry?.enabled === false) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "disabled-in-config",
    };
  }
  const explicitlyAllowed = params.config.allow.includes(params.id);
  if (
    params.origin === "workspace" &&
    !explicitlyAllowed &&
    entry?.enabled !== true &&
    explicitSelection.cause !== "selected-context-engine-slot"
  ) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "workspace-disabled-by-default",
    };
  }
  if (params.config.slots.memory === params.id) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: "selected-memory-slot",
    };
  }
  if (params.config.slots.contextEngine === params.id) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: "selected-context-engine-slot",
    };
  }
  // The bundled dreaming engine runs as a sidecar of the selected memory slot
  // plugin. Like the slot plugins above, it must activate even when a
  // restrictive allowlist names the memory plugin but not the engine, otherwise
  // dreaming sweeps silently stop. Higher-priority denials above (plugins
  // disabled, denylist, disabled-in-config) still apply because they return
  // earlier, so an operator can still explicitly disable the engine.
  if (params.isDreamingSidecar === true) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: "selected-dreaming-sidecar",
    };
  }
  if (
    params.allowBundledChannelExplicitBypassesAllowlist === true &&
    explicitSelection.cause === "bundled-channel-enabled-in-config"
  ) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: explicitSelection.cause,
    };
  }
  if (params.config.allow.length > 0 && !explicitlyAllowed) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "not-in-allowlist",
    };
  }
  if (explicitSelection.explicitlyEnabled) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: explicitSelection.cause,
    };
  }
  if (params.autoEnabledReason) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      reason: params.autoEnabledReason,
    };
  }
  if (entry?.enabled === true) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      cause: "enabled-by-effective-config",
    };
  }
  if (
    params.origin === "bundled" &&
    params.isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      cause: "bundled-channel-configured",
    };
  }
  if (params.origin === "bundled" && params.enabledByDefault === true) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "default",
      cause: "bundled-default-enablement",
    };
  }
  if (params.origin === "bundled") {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: false,
      source: "disabled",
      cause: "bundled-disabled-by-default",
    };
  }
  return {
    enabled: true,
    activated: true,
    explicitlyEnabled: explicitSelection.explicitlyEnabled,
    source: "default",
  };
}

export function toEnableStateResult(state: EnableStateLike): { enabled: boolean; reason?: string } {
  return state.enabled ? { enabled: true } : { enabled: false, reason: state.reason };
}

export function resolveEnableStateResult<TParams>(
  params: TParams,
  resolveState: (params: TParams) => EnableStateLike,
): { enabled: boolean; reason?: string } {
  return toEnableStateResult(resolveState(params));
}

export function createPluginEnableStateResolver<TConfig, TOrigin extends string>(
  resolveState: (params: {
    id: string;
    origin: TOrigin;
    config: TConfig;
    enabledByDefault?: boolean;
  }) => EnableStateLike,
): (
  id: string,
  origin: TOrigin,
  config: TConfig,
  enabledByDefault?: boolean,
) => { enabled: boolean; reason?: string } {
  return (id, origin, config, enabledByDefault) =>
    resolveEnableStateResult({ id, origin, config, enabledByDefault }, resolveState);
}

export function createEffectiveEnableStateResolver<TParams>(
  resolveState: (params: TParams) => EnableStateLike,
): (params: TParams) => { enabled: boolean; reason?: string } {
  return (params) => resolveEnableStateResult(params, resolveState);
}

function hasKind(kind: PluginKindLike, target: string): boolean {
  if (!kind) {
    return false;
  }
  return Array.isArray(kind) ? kind.includes(target) : kind === target;
}

export function resolveMemorySlotDecisionShared(params: {
  id: string;
  kind?: PluginKindLike;
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  if (!hasKind(params.kind, "memory")) {
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

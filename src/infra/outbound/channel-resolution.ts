// Channel resolution exposes read-only outbound runtime facades and performs
// optional bootstrap for deliverable channels that are not loaded yet.
import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import { supportsChannelMessageAction } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  bootstrapOutboundChannelPlugin,
  bootstrapOutboundChannelPluginAsync,
} from "./channel-bootstrap.runtime.js";
import { findChannelPluginInRegistry } from "./runtime-visible-channels.js";

/** Normalizes a raw channel id and rejects non-deliverable/internal channels. */
export function normalizeDeliverableOutboundChannel(raw?: string | null): string | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized || !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function getOutboundRuntimeRegistry(): PluginRegistry | null {
  return getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
}

type OutboundChannelResolutionParams = {
  channel: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  allowBootstrap?: boolean;
  requiredAction?: ChannelMessageActionName;
};

type BootstrapRequest = Parameters<typeof bootstrapOutboundChannelPlugin>[0];

function* normalizeOutboundChannelForResolution(params: OutboundChannelResolutionParams): Generator<
  BootstrapRequest,
  {
    channel?: string;
    didBootstrap: boolean;
    bootstrapRegistry?: PluginRegistry;
  },
  PluginRegistry | undefined
> {
  const normalized = normalizeMessageChannel(params.channel);
  const deliverable =
    normalized && isDeliverableMessageChannel(normalized) ? normalized : undefined;
  if (deliverable || !normalized || normalized === INTERNAL_MESSAGE_CHANNEL) {
    return { channel: deliverable, didBootstrap: false };
  }

  const activeRuntimePlugin = resolveOutboundPluginFromRuntimeRegistry(
    normalized,
    getOutboundRuntimeRegistry() ?? undefined,
    true,
    params.requiredAction,
  );
  if (activeRuntimePlugin) {
    return {
      channel: activeRuntimePlugin.id,
      didBootstrap: false,
    };
  }
  if (params.allowBootstrap !== true) {
    return { channel: undefined, didBootstrap: false };
  }

  // External channel ids remain normalized before their runtime is registered.
  // Bootstrap first, then let the runtime candidate lookup confirm sendability.
  const bootstrapRegistry = yield {
    channel: normalized,
    cfg: params.cfg,
    agentId: params.agentId,
    requiredAction: params.requiredAction,
  };
  const bootstrappedRuntimePlugin = resolveOutboundPluginFromRuntimeRegistry(
    normalized,
    bootstrapRegistry,
    true,
    params.requiredAction,
  );
  return {
    channel: bootstrappedRuntimePlugin?.id ?? normalized,
    didBootstrap: true,
    ...(bootstrapRegistry ? { bootstrapRegistry } : {}),
  };
}

function resolveSendCapableMessageAdapter(
  plugin: ChannelPlugin | undefined,
): ChannelMessageAdapterShape | undefined {
  const message = plugin?.message;
  return typeof message?.send?.text === "function" ? message : undefined;
}

function channelPluginHasRuntimeOutboundSurface(
  plugin: ChannelPlugin | undefined,
  requiredAction?: ChannelMessageActionName,
): boolean {
  return Boolean(
    plugin?.outbound ??
    resolveSendCapableMessageAdapter(plugin) ??
    supportsChannelMessageAction(plugin?.actions, requiredAction),
  );
}

function channelPluginHasActivatedOutboundSurface(
  plugin: ChannelPlugin | undefined,
  requiredAction?: ChannelMessageActionName,
): boolean {
  return Boolean(
    plugin?.outbound?.sendText ||
    plugin?.outbound?.deliveryMode === "gateway" ||
    resolveSendCapableMessageAdapter(plugin) ||
    supportsChannelMessageAction(plugin?.actions, requiredAction),
  );
}

function resolveRuntimeOutboundPluginCandidate(params: {
  loaded?: ChannelPlugin;
  runtime?: ChannelPlugin;
  setupFallback?: ChannelPlugin;
  bundled?: ChannelPlugin;
  allowSetupShell?: boolean;
  requireActivatedRuntime?: boolean;
  requiredAction?: ChannelMessageActionName;
}): ChannelPlugin | undefined {
  const hasRuntimeSurface = params.requireActivatedRuntime
    ? (plugin: ChannelPlugin | undefined) =>
        channelPluginHasActivatedOutboundSurface(plugin, params.requiredAction)
    : (plugin: ChannelPlugin | undefined) =>
        channelPluginHasRuntimeOutboundSurface(plugin, params.requiredAction);
  if (hasRuntimeSurface(params.loaded)) {
    return params.loaded;
  }
  if (hasRuntimeSurface(params.runtime)) {
    return params.runtime;
  }
  if (hasRuntimeSurface(params.bundled)) {
    return params.bundled;
  }
  if (params.allowSetupShell) {
    return params.loaded ?? params.setupFallback ?? params.bundled;
  }
  return undefined;
}

function resolveOutboundPluginFromRuntimeRegistry(
  channel: string,
  registry: PluginRegistry | null | undefined = getOutboundRuntimeRegistry(),
  requireActivatedRuntime = false,
  requiredAction?: ChannelMessageActionName,
): ChannelPlugin | undefined {
  const plugin = findChannelPluginInRegistry(registry, channel);
  const hasSurface = requireActivatedRuntime
    ? (candidate: ChannelPlugin | undefined) =>
        channelPluginHasActivatedOutboundSurface(candidate, requiredAction)
    : (candidate: ChannelPlugin | undefined) =>
        channelPluginHasRuntimeOutboundSurface(candidate, requiredAction);
  return hasSurface(plugin) ? plugin : undefined;
}

function* resolveOutboundChannelPluginSteps(
  params: OutboundChannelResolutionParams,
): Generator<BootstrapRequest, ChannelPlugin | undefined, PluginRegistry | undefined> {
  const {
    channel: normalized,
    didBootstrap,
    bootstrapRegistry,
  } = yield* normalizeOutboundChannelForResolution(params);
  if (!normalized) {
    return undefined;
  }

  const scopedPlugin = findChannelPluginInRegistry(
    bootstrapRegistry ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
    normalized,
  );
  if (scopedPlugin) {
    // A selected registration owns absent capabilities too. Only explicit
    // activation may replace a setup shell; never borrow a same-id sender.
    if (
      params.allowBootstrap !== true ||
      channelPluginHasActivatedOutboundSurface(scopedPlugin, params.requiredAction)
    ) {
      return scopedPlugin;
    }
    if (didBootstrap) {
      return undefined;
    }
    return resolveOutboundPluginFromRuntimeRegistry(
      normalized,
      yield { ...params, channel: normalized },
      true,
      params.requiredAction,
    );
  }

  const resolveLoaded = () => getLoadedChannelPlugin(normalized);
  const resolve = () => getChannelPlugin(normalized);
  const current = resolveLoaded();
  const requireActivatedRuntime = params.allowBootstrap === true;
  const runtimeCurrent = resolveOutboundPluginFromRuntimeRegistry(
    normalized,
    bootstrapRegistry,
    requireActivatedRuntime,
    params.requiredAction,
  );
  const setupFallback = findChannelPluginInRegistry(
    bootstrapRegistry ?? getOutboundRuntimeRegistry(),
    normalized,
  );
  const bundledCurrent = resolve();
  const candidate = resolveRuntimeOutboundPluginCandidate({
    loaded: current,
    runtime: runtimeCurrent,
    setupFallback,
    bundled: bundledCurrent,
    allowSetupShell: params.allowBootstrap !== true,
    requireActivatedRuntime,
    requiredAction: params.requiredAction,
  });
  if (candidate) {
    return candidate;
  }

  if (params.allowBootstrap !== true || didBootstrap) {
    return undefined;
  }

  const registry = yield {
    channel: normalized,
    cfg: params.cfg,
    agentId: params.agentId,
    requiredAction: params.requiredAction,
  };
  return resolveRuntimeOutboundPluginCandidate({
    loaded: resolveLoaded(),
    runtime: resolveOutboundPluginFromRuntimeRegistry(
      normalized,
      registry,
      true,
      params.requiredAction,
    ),
    setupFallback: findChannelPluginInRegistry(
      registry ?? getOutboundRuntimeRegistry(),
      normalized,
    ),
    bundled: resolve(),
    requireActivatedRuntime: true,
    requiredAction: params.requiredAction,
  });
}

/** Resolves a deliverable outbound channel plugin, optionally bootstrapping it. */
export function resolveOutboundChannelPlugin(
  params: OutboundChannelResolutionParams,
): ChannelPlugin | undefined {
  const steps = resolveOutboundChannelPluginSteps(params);
  let step = steps.next();
  while (!step.done) {
    step = steps.next(bootstrapOutboundChannelPlugin(step.value));
  }
  return step.value;
}

async function resolveOutboundChannelPluginAsync(
  params: OutboundChannelResolutionParams & { assertCurrent?: () => void },
): Promise<ChannelPlugin | undefined> {
  params.assertCurrent?.();
  const steps = resolveOutboundChannelPluginSteps(params);
  let step = steps.next();
  while (!step.done) {
    const registry = await bootstrapOutboundChannelPluginAsync({
      ...step.value,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent?.();
    step = steps.next(registry);
  }
  return step.value;
}

/** Resolves the message adapter after any required bootstrap metadata is ready. */
export async function resolveOutboundChannelMessageAdapter(
  params: OutboundChannelResolutionParams & { assertCurrent?: () => void },
): Promise<ChannelMessageAdapterShape | undefined> {
  const plugin = await resolveOutboundChannelPluginAsync(params);
  params.assertCurrent?.();
  return resolveSendCapableMessageAdapter(plugin);
}

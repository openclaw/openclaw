import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
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
  return normalized && isDeliverableMessageChannel(normalized) ? normalized : undefined;
}

function getOutboundRuntimeRegistry(): PluginRegistry | null {
  return getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
}

type OutboundChannelResolutionParams = {
  channel: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  allowBootstrap?: boolean;
};

type BootstrapRequest = Parameters<typeof bootstrapOutboundChannelPlugin>[0];

function resolveSendCapableMessageAdapter(
  plugin: ChannelPlugin | undefined,
): ChannelMessageAdapterShape | undefined {
  const message = plugin?.message;
  return typeof message?.send?.text === "function" ? message : undefined;
}

function hasOutboundSurface(
  plugin: ChannelPlugin | undefined,
  requireActivatedRuntime = false,
): boolean {
  return requireActivatedRuntime
    ? Boolean(
        plugin?.outbound?.sendText ||
        plugin?.outbound?.deliveryMode === "gateway" ||
        resolveSendCapableMessageAdapter(plugin),
      )
    : Boolean(plugin?.outbound ?? resolveSendCapableMessageAdapter(plugin));
}

function resolveRuntimeOutboundPluginCandidate(params: {
  loaded?: ChannelPlugin;
  runtime?: ChannelPlugin;
  setupFallback?: ChannelPlugin;
  bundled?: ChannelPlugin;
  requireActivatedRuntime?: boolean;
}): ChannelPlugin | undefined {
  return (
    [params.loaded, params.runtime, params.bundled].find((plugin) =>
      hasOutboundSurface(plugin, params.requireActivatedRuntime),
    ) ??
    (params.requireActivatedRuntime
      ? undefined
      : (params.loaded ?? params.setupFallback ?? params.bundled))
  );
}

function resolveOutboundPluginFromRuntimeRegistry(
  channel: string,
  registry: PluginRegistry | null | undefined = getOutboundRuntimeRegistry(),
  requireActivatedRuntime = false,
): ChannelPlugin | undefined {
  const plugin = findChannelPluginInRegistry(registry, channel);
  return hasOutboundSurface(plugin, requireActivatedRuntime) ? plugin : undefined;
}

function* resolveOutboundChannelPluginSteps(
  params: OutboundChannelResolutionParams,
): Generator<BootstrapRequest, ChannelPlugin | undefined, PluginRegistry | undefined> {
  const channel = normalizeMessageChannel(params.channel);
  let normalized = channel && isDeliverableMessageChannel(channel) ? channel : undefined;
  let didBootstrap = false;
  let bootstrapRegistry: PluginRegistry | undefined;
  if (!normalized && channel && channel !== INTERNAL_MESSAGE_CHANNEL) {
    const active = resolveOutboundPluginFromRuntimeRegistry(
      channel,
      getOutboundRuntimeRegistry() ?? undefined,
      true,
    );
    if (active) {
      normalized = active.id;
    } else if (params.allowBootstrap === true) {
      // External channel ids remain normalized before their runtime is registered.
      // Bootstrap first, then let the runtime candidate lookup confirm sendability.
      bootstrapRegistry = yield {
        channel,
        cfg: params.cfg,
        agentId: params.agentId,
      };
      normalized =
        resolveOutboundPluginFromRuntimeRegistry(channel, bootstrapRegistry, true)?.id ?? channel;
      didBootstrap = true;
    }
  }
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
    if (params.allowBootstrap !== true || hasOutboundSurface(scopedPlugin, true)) {
      return scopedPlugin;
    }
    if (didBootstrap) {
      return undefined;
    }
    return resolveOutboundPluginFromRuntimeRegistry(
      normalized,
      yield { ...params, channel: normalized },
      true,
    );
  }

  const current = getLoadedChannelPlugin(normalized);
  const requireActivatedRuntime = params.allowBootstrap === true;
  const runtimeCurrent = resolveOutboundPluginFromRuntimeRegistry(
    normalized,
    bootstrapRegistry,
    requireActivatedRuntime,
  );
  const setupFallback = findChannelPluginInRegistry(
    bootstrapRegistry ?? getOutboundRuntimeRegistry(),
    normalized,
  );
  const bundledCurrent = getChannelPlugin(normalized);
  const candidate = resolveRuntimeOutboundPluginCandidate({
    loaded: current,
    runtime: runtimeCurrent,
    setupFallback,
    bundled: bundledCurrent,
    requireActivatedRuntime,
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
  };
  return resolveRuntimeOutboundPluginCandidate({
    loaded: getLoadedChannelPlugin(normalized),
    runtime: resolveOutboundPluginFromRuntimeRegistry(normalized, registry, true),
    bundled: getChannelPlugin(normalized),
    requireActivatedRuntime: true,
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
  const steps = resolveOutboundChannelPluginSteps(params);
  let step = steps.next();
  while (!step.done) {
    const registry = await bootstrapOutboundChannelPluginAsync({
      ...step.value,
      assertCurrent: params.assertCurrent,
    });
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

import type {
  ChannelRuntimeContextKey,
  ChannelRuntimeSurface,
} from "../channels/plugins/channel-runtime-surface.types.js";

const NOOP_DISPOSE = () => {};

function resolveScopedRuntimeContextRegistry(params: {
  channelRuntime: ChannelRuntimeSurface;
}): ChannelRuntimeSurface["runtimeContexts"] {
  const runtimeContexts = resolveRuntimeContextRegistry(params);
  if (
    runtimeContexts &&
    typeof runtimeContexts.register === "function" &&
    typeof runtimeContexts.get === "function" &&
    typeof runtimeContexts.watch === "function"
  ) {
    return runtimeContexts;
  }
  throw new Error(
    "channelRuntime must provide runtimeContexts.register/get/watch; pass createPluginRuntime().channel or omit channelRuntime.",
  );
}

function resolveRuntimeContextRegistry(params: {
  channelRuntime?: ChannelRuntimeSurface;
}): ChannelRuntimeSurface["runtimeContexts"] | null {
  return params.channelRuntime?.runtimeContexts ?? null;
}

/**
 * Registers a channel/account/capability runtime context when a runtime surface is available.
 *
 * Returns null when the caller is running without a channel runtime, letting plugin code offer
 * optional runtime capabilities without branching at every call site.
 */
export function registerChannelRuntimeContext(
  params: ChannelRuntimeContextKey & {
    channelRuntime?: ChannelRuntimeSurface;
    context: unknown;
    abortSignal?: AbortSignal;
  },
): { dispose: () => void } | null {
  const runtimeContexts = resolveRuntimeContextRegistry(params);
  if (!runtimeContexts) {
    return null;
  }
  return runtimeContexts.register({
    channelId: params.channelId,
    accountId: params.accountId,
    capability: params.capability,
    context: params.context,
    abortSignal: params.abortSignal,
  });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Runtime context values are caller-typed by key.
/**
 * Reads a typed runtime context for a channel/account/capability key.
 *
 * The registry stores unknown values; callers own the type by agreeing on the capability key.
 */
export function getChannelRuntimeContext<T = unknown>(
  params: ChannelRuntimeContextKey & {
    channelRuntime?: ChannelRuntimeSurface;
  },
): T | undefined {
  const runtimeContexts = resolveRuntimeContextRegistry(params);
  if (!runtimeContexts) {
    return undefined;
  }
  return runtimeContexts.get<T>({
    channelId: params.channelId,
    accountId: params.accountId,
    capability: params.capability,
  });
}

/**
 * Subscribes to runtime context registration changes for one channel/account/capability key.
 *
 * Returns null when no runtime surface exists; otherwise the returned function only unregisters
 * this watcher and does not dispose the context lease itself.
 */
export function watchChannelRuntimeContexts(
  params: ChannelRuntimeContextKey & {
    channelRuntime?: ChannelRuntimeSurface;
    onEvent: Parameters<ChannelRuntimeSurface["runtimeContexts"]["watch"]>[0]["onEvent"];
  },
): (() => void) | null {
  const runtimeContexts = resolveRuntimeContextRegistry(params);
  if (!runtimeContexts) {
    return null;
  }
  return runtimeContexts.watch({
    channelId: params.channelId,
    accountId: params.accountId,
    capability: params.capability,
    onEvent: params.onEvent,
  });
}

/**
 * Wraps a channel runtime so contexts registered during one task are disposed together.
 *
 * Contexts registered through the scoped wrapper are tracked and disposed by the returned cleanup,
 * while contexts registered directly on the base runtime remain persistent.
 */
export function createTaskScopedChannelRuntime<T extends ChannelRuntimeSurface>(params: {
  channelRuntime?: T;
}): {
  channelRuntime?: T;
  dispose: () => void;
} {
  const baseRuntime = params.channelRuntime;
  if (!baseRuntime) {
    return {
      channelRuntime: undefined,
      dispose: NOOP_DISPOSE,
    };
  }
  const runtimeContexts = resolveScopedRuntimeContextRegistry({ channelRuntime: baseRuntime });

  const trackedLeases = new Set<{ dispose: () => void }>();
  const trackLease = (lease: { dispose: () => void }) => {
    trackedLeases.add(lease);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        trackedLeases.delete(lease);
        lease.dispose();
      },
    };
  };

  const scopedRuntime = {
    ...baseRuntime,
    runtimeContexts: {
      ...runtimeContexts,
      register: (registerParams) => {
        const lease = runtimeContexts.register(registerParams);
        return trackLease(lease);
      },
    },
  } as T;

  return {
    channelRuntime: scopedRuntime,
    dispose: () => {
      for (const lease of Array.from(trackedLeases)) {
        lease.dispose();
      }
    },
  };
}

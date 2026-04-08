import type { PluginRuntime } from "../plugins/runtime/types.js";

export type ChannelRuntimeContextKey = {
  channelId: string;
  accountId?: string | null;
  capability: string;
};

const NOOP_DISPOSE = () => {};

function resolveScopedRuntimeContextRegistry(params: {
  channelRuntime: PluginRuntime["channel"];
}): PluginRuntime["channel"]["runtimeContexts"] {
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
  channelRuntime?: PluginRuntime["channel"];
}): PluginRuntime["channel"]["runtimeContexts"] | null {
  return params.channelRuntime?.runtimeContexts ?? null;
}

export function registerChannelRuntimeContext(
  params: ChannelRuntimeContextKey & {
    channelRuntime?: PluginRuntime["channel"];
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

export function getChannelRuntimeContext<T = unknown>(
  params: ChannelRuntimeContextKey & {
    channelRuntime?: PluginRuntime["channel"];
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

export function watchChannelRuntimeContexts(
  params: ChannelRuntimeContextKey & {
    channelRuntime?: PluginRuntime["channel"];
    onEvent: Parameters<PluginRuntime["channel"]["runtimeContexts"]["watch"]>[0]["onEvent"];
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

export function createTaskScopedChannelRuntime(params: {
  channelRuntime?: PluginRuntime["channel"];
}): {
  channelRuntime?: PluginRuntime["channel"];
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

  const scopedRuntime: PluginRuntime["channel"] = {
    ...baseRuntime,
    runtimeContexts: {
      ...runtimeContexts,
      register: (registerParams) => {
        const lease = runtimeContexts.register(registerParams);
        return trackLease(lease);
      },
    },
  };

  return {
    channelRuntime: scopedRuntime,
    dispose: () => {
      for (const lease of Array.from(trackedLeases)) {
        lease.dispose();
      }
    },
  };
}

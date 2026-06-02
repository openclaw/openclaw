export type ChannelRuntimeContextKey = {
  /** Channel/plugin id that owns the runtime context. */
  channelId: string;
  /** Optional configured account id; omitted means channel-wide runtime state. */
  accountId?: string | null;
  /** Capability namespace for the context, such as `approval.native`. */
  capability: string;
};

/** Runtime context lifecycle event delivered to matching watchers. */
export type ChannelRuntimeContextEvent = {
  type: "registered" | "unregistered";
  key: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
  context?: unknown;
};

export type ChannelRuntimeContextRegistry = {
  /** Register one context lease; disposing the lease unregisters only that exact registration. */
  register: (
    params: ChannelRuntimeContextKey & {
      context: unknown;
      abortSignal?: AbortSignal;
    },
  ) => { dispose: () => void };
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Runtime context values are caller-typed by key.
  /** Read the current context for an exact key, typed by caller-owned capability convention. */
  get: <T = unknown>(params: ChannelRuntimeContextKey) => T | undefined;
  /** Watch registration changes matching the optional key filters. */
  watch: (params: {
    channelId?: string;
    accountId?: string | null;
    capability?: string;
    onEvent: (event: ChannelRuntimeContextEvent) => void;
  }) => () => void;
};

/**
 * Minimal channel-runtime surface exported through the public plugin SDK.
 *
 * Gateway startup supplies the full plugin channel runtime, but external callers
 * may still type context-only helpers against this compatibility surface.
 */
export type ChannelRuntimeSurface = {
  runtimeContexts: ChannelRuntimeContextRegistry;
  [key: string]: unknown;
};

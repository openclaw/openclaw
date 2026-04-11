export const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type RuntimeTrackedChannelRegistry = {
  channels?: Array<{
    plugin: {
      id?: string | null;
      meta?: {
        aliases?: readonly string[];
        markdownCapable?: boolean;
      } | null;
      conversationBindings?: {
        supportsCurrentConversationBinding?: boolean;
      } | null;
    };
  }>;
};

type GlobalChannelRegistryState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    activeVersion?: number;
    activeRegistry?: RuntimeTrackedChannelRegistry | null;
    channel?: {
      registry: RuntimeTrackedChannelRegistry | null;
      version?: number;
    };
  };
};

export function getActivePluginChannelRegistryFromState(): RuntimeTrackedChannelRegistry | null {
  const state = (globalThis as GlobalChannelRegistryState)[PLUGIN_REGISTRY_STATE];
  return state?.channel?.registry ?? state?.activeRegistry ?? null;
}

export function getActivePluginChannelRegistryVersionFromState(): number {
  const state = (globalThis as GlobalChannelRegistryState)[PLUGIN_REGISTRY_STATE];
  return state?.channel?.registry ? (state.channel.version ?? 0) : (state?.activeVersion ?? 0);
}

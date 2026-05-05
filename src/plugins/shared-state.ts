const PLUGIN_SHARED_STATE_KEY = Symbol.for("openclaw.plugins.sharedState.v1");

type PluginSharedState = Record<string, unknown>;

type GlobalStore = typeof globalThis & {
  [PLUGIN_SHARED_STATE_KEY]?: Map<string, PluginSharedState>;
};

function resolvePluginSharedStateMap(): Map<string, PluginSharedState> {
  const store = globalThis as GlobalStore;
  let states = store[PLUGIN_SHARED_STATE_KEY];
  if (!states) {
    states = new Map<string, PluginSharedState>();
    store[PLUGIN_SHARED_STATE_KEY] = states;
  }
  return states;
}

export function getPluginSharedState(pluginId: string): PluginSharedState {
  const states = resolvePluginSharedStateMap();
  let state = states.get(pluginId);
  if (!state) {
    state = Object.create(null) as PluginSharedState;
    states.set(pluginId, state);
  }
  return state;
}

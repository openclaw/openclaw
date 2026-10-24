import "./plugin-node-host.js";

type NodeHostPluginTestApi = {
  resetNodeHostPluginRegistry(): void;
};

function getTestApi(): NodeHostPluginTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.nodeHostPluginTestApi")
  ] as NodeHostPluginTestApi;
}

export function resetNodeHostPluginRegistry(): void {
  getTestApi().resetNodeHostPluginRegistry();
}

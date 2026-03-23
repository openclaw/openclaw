import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  clearFallbackGatewayContext,
  getFallbackGatewayContext,
  setFallbackGatewayContext,
} from "./server-plugins.js";

export type RuntimeStateContainer = {
  secretsRuntime: {
    activate: (snapshot: PreparedSecretsRuntimeSnapshot) => void;
    getActive: () => PreparedSecretsRuntimeSnapshot | null;
    clear: () => void;
  };
  fallbackGatewayContext: {
    set: (context: GatewayRequestContext) => void;
    get: () => GatewayRequestContext | undefined;
    clear: () => void;
  };
};

export function createGlobalRuntimeStateContainer(): RuntimeStateContainer {
  return {
    secretsRuntime: {
      activate: (snapshot) => {
        activateSecretsRuntimeSnapshot(snapshot);
      },
      getActive: () => getActiveSecretsRuntimeSnapshot(),
      clear: () => {
        clearSecretsRuntimeSnapshot();
      },
    },
    fallbackGatewayContext: {
      set: (context) => {
        setFallbackGatewayContext(context);
      },
      get: () => getFallbackGatewayContext(),
      clear: () => {
        clearFallbackGatewayContext();
      },
    },
  };
}

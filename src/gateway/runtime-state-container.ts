import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";

export type RuntimeStateContainer = {
  secretsRuntime: {
    activate: (snapshot: PreparedSecretsRuntimeSnapshot) => void;
    getActive: () => PreparedSecretsRuntimeSnapshot | null;
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
  };
}

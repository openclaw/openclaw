import {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "./runtime-matrix-boundary.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeMatrix(): PluginRuntimeChannel["matrix"] {
  return {
    threadBindings: {
      setIdleTimeoutBySessionKey: setMatrixThreadBindingIdleTimeoutBySessionKey,
      setMaxAgeBySessionKey: setMatrixThreadBindingMaxAgeBySessionKey,
    },
  };
}

import {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "../../../extensions/matrix/runtime-api.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeMatrix(): PluginRuntimeChannel["matrix"] {
  return {
    threadBindings: {
      setIdleTimeoutBySessionKey: setMatrixThreadBindingIdleTimeoutBySessionKey,
      setMaxAgeBySessionKey: setMatrixThreadBindingMaxAgeBySessionKey,
    },
  };
}

export {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  getRuntimeConfigSnapshot,
  readRuntimeConfig,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
export {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  getRuntimeConfigSourceSnapshot,
} from "../config/io.js";
export { getRuntimeConfig } from "./runtime-config-legacy.js";
export type { OpenClawConfig } from "../config/types.js";

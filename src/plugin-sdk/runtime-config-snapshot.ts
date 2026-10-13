/**
 * Runtime SDK subpath for config snapshot and config cache access.
 */
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

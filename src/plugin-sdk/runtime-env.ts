// Shared process/runtime utilities for plugins. This is the public boundary for
// logger wiring, runtime env shims, and global verbose console helpers.

export type { RuntimeEnv } from "../runtime.js";
export { createNonExitingRuntime, defaultRuntime } from "../runtime.js";
export {
  danger,
  info,
  isVerbose,
  isYes,
  logVerbose,
  logVerboseConsole,
  setVerbose,
  setYes,
  shouldLogVerbose,
  success,
  warn,
} from "../globals.js";
export { isTruthyEnvValue } from "../infra/env.js";
export * from "../logging.js";
export { waitForAbortSignal } from "../infra/abort-signal.js";
export { retryAsync } from "../infra/retry.js";
export { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
export { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
export { isWSL2Sync } from "../infra/wsl.js";

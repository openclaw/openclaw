// Keeps plugin/runtime modules outside the core scan files until a caller needs them.

export {
  getActiveMemoryProviderCore as getMemoryProvider,
  getActiveMemorySearchManagerCore as getMemorySearchManager,
  isActiveMemoryProviderNative as isMemoryProviderNative,
} from "../plugins/memory-runtime.js";

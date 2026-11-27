/**
 * Runtime SDK subpath for active memory search manager operations.
 */
export {
  closeActiveMemorySearchManagerCore as closeActiveMemorySearchManager,
  closeActiveMemorySearchManagersCore as closeActiveMemorySearchManagers,
  getActiveMemorySearchManagerCore as getActiveMemorySearchManager,
  getActiveMemoryProviderCore as getActiveMemoryProvider,
  isActiveMemoryProviderNative,
  resolveActiveMemoryBackendConfig,
} from "../plugins/memory-runtime.js";

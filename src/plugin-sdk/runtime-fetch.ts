// Narrow runtime fetch helpers for plugins that need dispatcher-aware fetch
// without importing the broad infra-runtime compatibility barrel.

export {
  fetchWithRuntimeDispatcher,
  fetchWithRuntimeDispatcherOrMockedGlobal,
  type DispatcherAwareRequestInit,
} from "../infra/net/runtime-fetch.js";

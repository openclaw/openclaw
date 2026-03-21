export {
  gateRegistration,
  gateRuntime,
  REGISTER_METHOD_CAPABILITIES,
  RUNTIME_PROPERTY_CAPABILITIES,
} from "./enforce.js";
export type { CapabilityDiagnostic, CapabilityEnforcementMode } from "./enforce.js";
export { createUnrestrictedCapabilities, resolveCapabilities } from "./resolve.js";
export type {
  PluginCapabilities,
  PluginRegisterCapability,
  PluginRuntimeCapability,
  ResolvedCapabilities,
} from "./types.js";
export {
  ALL_REGISTER_CAPABILITIES,
  ALL_RUNTIME_CAPABILITIES,
  CAPABILITY_WILDCARD,
} from "./types.js";

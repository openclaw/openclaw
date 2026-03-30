export type {
  AilliumIntegrationBoundary,
  ContextLifecycleEvent,
  ContextLifecycleHook,
  ContractAdapter,
  EvidenceCallbackHook,
  JsonPrimitive,
  JsonValue,
  RuntimeRegistrationAdapter,
  RuntimeRegistrationInput,
  RuntimeRegistrationResult,
  TenantSessionMetadata,
  TenantSessionMetadataAdapter,
} from "./contracts.js";

export { createDefaultAilliumBoundary } from "./defaults.js";
export { createLiveAilliumBoundary } from "./live-boundary.js";
export type { AilliumCoreConnectionConfig } from "./live-boundary.js";

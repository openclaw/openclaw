/** Production-private native session coordination for official harness plugins. */
export {
  createNativeSessionBindingLifecycle,
  createNativeSessionBindingLifecycleV2,
  type NativeSessionBindingLeaseOptions,
  type NativeSessionBindingStateStore,
  type NativeSessionBindingStateStoreV2,
} from "../agents/harness/native-session/binding-lifecycle.js";
export {
  captureNativeSessionGenerationAuthority,
  reclaimNativeSessionGeneration,
  resolveNativeSessionBinding,
  type NativeSessionGenerationOperations,
  type NativeSessionGenerationReclaimPlan,
  type NativeSessionGenerationAdoptionResult,
} from "../agents/harness/native-session/binding-generation.js";
export {
  prepareNativeSessionGenerationAuthority,
  retainNativeSessionGenerationAuthority,
  reclaimNativeSessionGenerationWithAuthority,
  resolveNativeSessionBindingWithAuthority,
  resolvePreparedNativeSessionBinding,
  type NativeSessionGenerationOperationsV2,
  type PreparedNativeSessionGenerationOperations,
  type RetainedNativeSessionGenerationAuthority,
} from "../agents/harness/native-session/binding-generation-authority.js";
export { createNativeSessionInitializationOwner } from "../agents/harness/native-session/initialization.js";

export {
  createNativeSessionBindingAuthority,
  createNativeSessionBindingScope,
  createPreparedNativeSessionBindingAuthority,
  combineNativeSessionBindingAuthority,
  combinePreparedNativeSessionBindingAuthority,
  type NativeSessionBindingAuthority,
  type PreparedNativeSessionBindingAuthority,
  type NativeSessionBindingWithCurrent,
} from "../agents/harness/native-session/binding-authority.js";
export {
  createNativeSessionCommitFinalizer,
  wrapNativeSessionDeletionMutation,
  isNativeSessionDeletionUnresolved,
} from "../agents/harness/native-session/deletion-participant.js";

// Narrow shared secret-contract exports for channel/plugin secret surfaces.

export {
  collectConditionalChannelFieldAssignments,
  collectNestedChannelFieldAssignments,
  collectNestedChannelTtsAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelRecord,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  isBaseFieldActiveForChannelSurface,
  normalizeSecretStringValue,
  resolveChannelAccountSurface,
} from "../secrets/channel-secret-collector-runtime.js";
export type {
  ChannelAccountEntry,
  ChannelAccountPredicate,
  ChannelAccountSurface,
} from "../secrets/channel-secret-collector-runtime.js";
export {
  collectSecretInputAssignment,
  hasOwnProperty,
  isEnabledFlag,
  pushAssignment,
  pushInactiveSurfaceWarning,
  pushWarning,
} from "../secrets/runtime-shared.js";
export type { ResolverContext, SecretDefaults } from "../secrets/runtime-shared.js";
export { isRecord } from "../secrets/shared.js";
export type { SecretTargetRegistryEntry } from "../secrets/target-registry-types.js";

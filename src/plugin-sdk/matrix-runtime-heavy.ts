// Matrix runtime helpers that are needed internally by the bundled extension
// but are too heavy for the light external runtime-api surface.

export { ensureConfiguredAcpBindingReady } from "../acp/persistent-bindings.lifecycle.js";
export { resolveConfiguredAcpBindingRecord } from "../acp/persistent-bindings.resolve.js";
export {
  autoPrepareLegacyMatrixCrypto,
  detectLegacyMatrixCrypto,
} from "../infra/matrix-legacy-crypto.js";
export {
  autoMigrateLegacyMatrixState,
  detectLegacyMatrixState,
} from "../infra/matrix-legacy-state.js";
export {
  hasActionableMatrixMigration,
  hasPendingMatrixMigration,
  maybeCreateMatrixMigrationSnapshot,
} from "../infra/matrix-migration-snapshot.js";
export { dispatchReplyFromConfigWithSettledDispatcher } from "./inbound-reply-dispatch.js";

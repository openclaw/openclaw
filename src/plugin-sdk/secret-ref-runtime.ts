// Narrow shared secret-ref helpers for plugin config and secret-contract paths.

export { coerceSecretRef } from "../config/types.secrets.js";
export type { SecretInput, SecretRef } from "../config/types.secrets.js";
export { resolveSecretRefValues } from "../secrets/resolve.js";
export { applyResolvedAssignments, createResolverContext } from "../secrets/runtime-shared.js";
export {
  resolveConfigSecretTargetByPath,
  resolvePlanTargetAgainstRegistry,
} from "../secrets/target-registry-query.js";
export type { ResolvedPlanTarget } from "../secrets/target-registry-types.js";

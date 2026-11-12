import { assertNoLegacyDeviceAuth } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals-store.js";
import { getExistingOpenClawStateSchemaPath } from "../state/openclaw-state-db-schema-policy.js";
import { initializeNativeOpenClawStateDatabase } from "../state/openclaw-state-db.js";

export function ensureNodeHostStateReady(): void {
  // Native clients can create version-zero tables before this node starts.
  // Complete their canonical bootstrap before read-only readiness checks.
  if (!getExistingOpenClawStateSchemaPath()) {
    initializeNativeOpenClawStateDatabase();
  }
  assertNoLegacyDeviceAuth(process.env);
  loadExecApprovalsReadOnly();
  loadDeviceIdentityIfPresent();
}

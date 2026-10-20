import { loadDeviceIdentityIfPresentAsync } from "../infra/device-identity-async.js";
import { assertNoPendingLegacyExecApprovals } from "../infra/exec-approvals-migration-gate.js";

export async function ensureNodeHostStateReady(): Promise<void> {
  assertNoPendingLegacyExecApprovals();
  await loadDeviceIdentityIfPresentAsync();
}

import { clearStoredChatSnapshots } from "../pages/chat/session-snapshot-invalidation.ts";
import { clearBootRecords, type BootRecordOwner } from "./boot-record.ts";

export function clearWarmBootState(gatewayScope: string, owner: BootRecordOwner): Promise<void> {
  // The boot record gates the next warm boot, so it must be gone before any
  // await: a reload during storage cleanup must fail closed.
  clearBootRecords(gatewayScope, owner);
  const recoveryScope = owner.recoveryScope;
  if (!recoveryScope) {
    return Promise.resolve();
  }
  // Invalidate visible history and its cursor before pane subscribers resume startup.
  return clearStoredChatSnapshots(`scope:${JSON.stringify([gatewayScope, recoveryScope])}\u0000`);
}

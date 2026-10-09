import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import { updateExecApprovalsForMaintenance } from "./exec-approvals-store.js";

export function saveExecApprovals(file: ExecApprovalsFile): void {
  updateExecApprovalsForMaintenance({ update: () => file });
}

type ExecApprovalsStoreTestApi = {
  reset(): void;
};

function getTesting(): ExecApprovalsStoreTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.execApprovalsStoreTestApi")
  ] as ExecApprovalsStoreTestApi;
}

export const testing: ExecApprovalsStoreTestApi = {
  reset: () => getTesting().reset(),
};

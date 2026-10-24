// Exec approval policy file helpers without the broad infra-runtime barrel.
import {
  loadExecApprovals as loadExecApprovalsSync,
  readExecApprovalsSnapshot as readExecApprovalsSnapshotSync,
} from "../infra/exec-approvals.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

/** @deprecated Await loadExecApprovalsReadOnlyAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
function loadExecApprovalsDeprecated() {
  warnPluginSdkDeprecation({
    family: "exec-approvals-sync-read",
    method: "loadExecApprovals",
    replacement: "loadExecApprovalsReadOnlyAsync",
  });
  return loadExecApprovalsSync();
}

/** @deprecated Await readExecApprovalsSnapshotAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
function readExecApprovalsSnapshotDeprecated() {
  warnPluginSdkDeprecation({
    family: "exec-approvals-sync-read",
    method: "readExecApprovalsSnapshot",
    replacement: "readExecApprovalsSnapshotAsync",
  });
  return readExecApprovalsSnapshotSync();
}

export {
  loadExecApprovalsDeprecated as loadExecApprovals,
  readExecApprovalsSnapshotDeprecated as readExecApprovalsSnapshot,
};

export {
  loadExecApprovalsReadOnlyAsync,
  readExecApprovalsSnapshotAsync,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsFromFile,
  resolveExecModePolicy,
  type ExecApprovalsFile,
} from "../infra/exec-approvals.js";

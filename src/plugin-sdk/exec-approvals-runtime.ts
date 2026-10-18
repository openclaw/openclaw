// Exec approval policy file helpers without the broad infra-runtime barrel.
import {
  loadExecApprovals as loadExecApprovalsSync,
  readExecApprovalsSnapshot as readExecApprovalsSnapshotSync,
} from "../infra/exec-approvals.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

/** @deprecated Await loadExecApprovalsReadOnlyAsync; removal follows a stable deprecation period. */
function loadExecApprovalsDeprecated() {
  warnPluginSdkDeprecation({
    family: "exec-approvals-sync-read",
    method: "loadExecApprovals",
    replacement: "loadExecApprovalsReadOnlyAsync",
  });
  return loadExecApprovalsSync();
}

/** @deprecated Await readExecApprovalsSnapshotAsync; removal follows a stable deprecation period. */
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

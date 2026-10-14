import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import {
  normalizeExecApprovals,
  readExecApprovalsSnapshotAsync,
  updateExecApprovals,
  type ExecApprovalsFile,
  type ExecApprovalsSnapshot,
} from "../infra/exec-approvals.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

type LocalExecApprovalsSnapshot = Pick<ExecApprovalsSnapshot, "path" | "exists" | "hash" | "file">;

export function loadSnapshotLocal(): Promise<LocalExecApprovalsSnapshot> {
  return runWithLocalStateOwner({
    method: "exec.approvals.get",
    params: {},
    target: "default exec approvals",
    requiredCapabilities: [GATEWAY_SERVER_CAPS.EXEC_APPROVALS_GET_OWNER],
    recoveryCommand: "openclaw approvals get --json",
    runLocal: async ({ assertCurrent }) => {
      assertCurrent();
      const snapshot = await readExecApprovalsSnapshotAsync();
      assertCurrent();
      return {
        path: snapshot.path,
        exists: snapshot.exists,
        hash: snapshot.hash,
        file: snapshot.file,
      };
    },
  });
}

export function saveSnapshotLocal(
  file: ExecApprovalsFile,
  baseHash: string,
): Promise<LocalExecApprovalsSnapshot> {
  const normalized = normalizeExecApprovals(file);
  return runWithLocalStateOwner({
    method: "exec.approvals.set",
    params: { file: normalized, baseHash },
    target: "default exec approvals",
    requiredCapabilities: [GATEWAY_SERVER_CAPS.EXEC_APPROVALS_SET_OWNER],
    recoveryCommand: "openclaw approvals get --json",
    runLocal: async ({ assertCurrent }) => {
      assertCurrent();
      const context = captureOpenClawStateWorkerContext();
      const snapshot = await updateExecApprovals(
        {
          baseHash,
          assertCurrent,
          update: { kind: "replace", file: normalized, preserveSocket: true },
        },
        context,
      );
      if (!snapshot) {
        throw new Error("Exec approvals changed; reload and retry.");
      }
      return snapshot;
    },
  });
}

import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import {
  commitNativeExecAuthorization,
  type NativeExecAuthorization,
} from "../infra/exec-approvals-native.js";
import { readExecApprovalsSocket } from "../infra/exec-approvals-socket.js";
import {
  normalizeExecApprovals,
  readExecApprovalsSnapshotAsync,
  redactExecApprovals,
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
    databaseEngine: "configured",
    requiredCapabilities: [GATEWAY_SERVER_CAPS.EXEC_APPROVALS_GET_OWNER],
    recoveryCommand: "openclaw approvals get --json",
    runLocal: async ({ env, assertCurrent }) => {
      assertCurrent();
      const snapshot = await readExecApprovalsSnapshotAsync();
      assertCurrent();
      const socket = await readExecApprovalsSocket(env, { assertCurrent });
      assertCurrent();
      return redactExecApprovals({
        ...snapshot,
        file: socket?.socket_path
          ? { ...snapshot.file, socket: { ...snapshot.file.socket, path: socket.socket_path } }
          : snapshot.file,
      });
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
    databaseEngine: "configured",
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
      return redactExecApprovals(snapshot);
    },
  });
}

export function commitNativeExecLocal(
  input: NativeExecAuthorization,
): Promise<{ authorized: true }> {
  return runWithLocalStateOwner({
    method: "exec.approvals.native.commit",
    params: input,
    target: "native exec authorization",
    databaseEngine: "configured",
    requiredCapabilities: [GATEWAY_SERVER_CAPS.EXEC_APPROVALS_NATIVE_COMMIT],
    recoveryCommand: "openclaw approvals get --json",
    runLocal: async ({ assertCurrent }) => {
      assertCurrent();
      return commitNativeExecAuthorization(
        input,
        assertCurrent,
        captureOpenClawStateWorkerContext(),
      );
    },
  });
}

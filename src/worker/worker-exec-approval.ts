import type { ExecApprovalTransport } from "../agents/bash-tools.exec-approval-request.js";
import { abortable } from "../agents/embedded-agent-runner/run/abortable.js";
import type { WorkerConnection } from "./worker-connection.js";

/** Only approval data crosses the worker connection; Gateway credentials stay on the host. */
export function createWorkerExecApprovalTransport(
  client: Pick<
    WorkerConnection,
    "requestExecApproval" | "requestExecApprovalDecision" | "captureExecApprovalAuthority"
  >,
  signal?: AbortSignal,
): ExecApprovalTransport {
  const assertConnectionCurrent = client.captureExecApprovalAuthority();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertConnectionCurrent();
  };
  const wait = <T>(request: Promise<T>) => (signal ? abortable(signal, request) : request);
  return {
    assertCurrent,
    async request(params) {
      assertCurrent();
      if (!params.command) {
        throw new Error("Worker exec approval requires a command");
      }
      const response = await wait(
        client.requestExecApproval({
          id: params.id,
          command: params.command,
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
          ...(params.warningText ? { warningText: params.warningText } : {}),
        }),
      );
      assertCurrent();
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.payload;
    },
    async waitDecision(params) {
      assertCurrent();
      const response = await wait(client.requestExecApprovalDecision(params));
      assertCurrent();
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.payload;
    },
  };
}

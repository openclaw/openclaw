import type { ExecApprovalTransport } from "../agents/bash-tools.exec-approval-request.js";
import { abortable } from "../agents/embedded-agent-runner/run/abortable.js";
import type { WorkerConnection } from "./worker-connection.js";

/** Only approval data crosses the worker connection; Gateway credentials stay on the host. */
export function createWorkerExecApprovalTransport(
  client: Pick<WorkerConnection, "requestExecApproval" | "requestExecApprovalDecision">,
  signal?: AbortSignal,
): ExecApprovalTransport {
  const wait = <T>(request: Promise<T>) => (signal ? abortable(signal, request) : request);
  return {
    async request(params) {
      signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.payload;
    },
    async waitDecision(params) {
      signal?.throwIfAborted();
      const response = await wait(client.requestExecApprovalDecision(params));
      signal?.throwIfAborted();
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.payload;
    },
  };
}

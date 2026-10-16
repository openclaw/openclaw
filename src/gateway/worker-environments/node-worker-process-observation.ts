import { Value } from "typebox/value";
import {
  SessionsProcessesListResultSchema,
  SessionsProcessesStopResultSchema,
} from "../../../packages/gateway-protocol/src/schema/session-processes.js";
import { NODE_WORKER_PROCESSES_COMMAND } from "../../infra/node-commands.js";
import type { NodeWorkerProcessInput } from "../../worker/worker-process-observation.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { parseNodeWorkerResponse } from "./node-worker-response.js";
import type { WorkerEnvironmentRecord } from "./store.js";

/** Process observations use one pinned node owner; an uncertain stop is never retried. */
export function createNodeWorkerProcessObserver(options: {
  gatewayNamespace: string;
  getEnvironment: (environmentId: string) => WorkerEnvironmentRecord | undefined;
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
}) {
  return async (
    input: Omit<NodeWorkerProcessInput, "gatewayNamespace">,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ) => {
    const record = options.getEnvironment(input.environmentId);
    const transport = options.getTransport();
    if (!record?.nodeDeviceId || !transport) {
      throw new Error("Worker process transport unavailable; reconnect the worker and retry.");
    }
    const authorize = () => {
      signal?.throwIfAborted();
      assertCurrent();
      const current = options.getEnvironment(input.environmentId);
      if (
        !current ||
        current.nodeDeviceId !== record.nodeDeviceId ||
        current.ownerEpoch !== input.ownerEpoch ||
        current.leaseId !== record.leaseId ||
        current.destroyRequestedAtMs !== null ||
        !["ready", "idle", "attached"].includes(current.state) ||
        options.getTransport() !== transport
      ) {
        throw new Error("Worker process placement changed; refresh the process list.");
      }
    };
    authorize();
    const node = await transport.getCurrentNode(record.nodeDeviceId);
    authorize();
    if (!node) {
      throw new Error("Worker process runner is offline; reconnect it and retry.");
    }
    const isDispatchAuthorized = () => {
      try {
        authorize();
        return transport.isCurrent(node);
      } catch {
        return false;
      }
    };
    // Do not retry a stop whose transport outcome is unknown.
    const result = await transport.invoke({
      node,
      command: NODE_WORKER_PROCESSES_COMMAND,
      params: { ...input, gatewayNamespace: options.gatewayNamespace },
      timeoutMs: 15_000,
      signal,
      isDispatchAuthorized,
    });
    authorize();
    if (!transport.isCurrent(node) || !result.ok) {
      throw new Error(
        "Worker process observation unavailable; update/reconnect the worker and retry. A requested stop may already have been accepted.",
      );
    }
    const payload = result.payloadJSON
      ? parseNodeWorkerResponse(result.payloadJSON, "Worker process observation")
      : result.payload;
    if (
      Value.Check(SessionsProcessesListResultSchema, payload) ||
      Value.Check(SessionsProcessesStopResultSchema, payload)
    ) {
      return payload;
    }
    throw new Error("Worker process observation returned an invalid response.");
  };
}

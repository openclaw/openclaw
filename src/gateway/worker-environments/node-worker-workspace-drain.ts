import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import {
  createNodeRunnerInventoryIssueError,
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
} from "../../infra/node-runner-inventory.js";
import type { WorkerExecutionMode } from "../../plugins/types.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecResult,
} from "../../worker/node-workspace-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { measureGatewayCloseStep } from "../restart-trace.js";
import { RETRYABLE_NODE_WORKER_TRANSPORT_CODES } from "./node-launch-adapter.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import type { NodeWorkerWorkspaceBinding } from "./node-worker-workspace-actions.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import {
  joinWorkerTunnelStops,
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTunnelStopReason,
} from "./tunnel-contract.js";

type NodeWorkerWorkspaceBindingIdentity = {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
};

export type NodeWorkerWorkspaceBindingResolver = ((
  binding: NodeWorkerWorkspaceBindingIdentity,
) => Promise<NodeWorkerWorkspaceBinding | undefined>) & {
  /** Durable placement read for teardown; never resolves session or worktree state. */
  durableDeviceFolder?: (
    binding: NodeWorkerWorkspaceBindingIdentity,
  ) => Promise<string | undefined>;
};

type NodeWorkerWorkspaceDrainRequest = {
  gatewayNamespace: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
  deviceFolder?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  findNode: (signal: AbortSignal) => Promise<{
    transport: NodeWorkerSupervisorTransport;
    node: NodeWorkerSupervisorNodeProof;
  }>;
  isAuthorized: () => boolean;
};

/** Remote acknowledgements share one budget; native owners retain unconfirmed cleanup. */
export async function stopNodeWorkerWorkspaceOwner(
  owner: {
    executionMode: WorkerExecutionMode;
    drainLocalWork?: () => Promise<void>;
  },
  params: NodeWorkerWorkspaceDrainRequest,
  reason?: WorkerTunnelStopReason,
) {
  const run = (
    name: string,
    operation: (request: NodeWorkerWorkspaceDrainRequest) => Promise<void>,
  ) => measureGatewayCloseStep(`shutdown.worker-environment.node-${name}`, () => operation(params));
  // Stop native processes before joining queues they may hold. Remote-exec
  // attachments retain their independently owned app processes across shutdown.
  const remoteStop =
    owner.executionMode === "worker-turn" && reason === undefined
      ? run("stop", stopNodeWorkerWorkspaceEnvironment)
      : undefined;
  const stopped = joinWorkerTunnelStops([remoteStop, owner.drainLocalWork?.()]);
  // Older nodes can still drain workspace work when native environment stop is unavailable.
  const drain = () =>
    reason !== "provider-destroying" && reason !== "provider-destroyed"
      ? run("drain", drainNodeWorkerWorkspace)
      : undefined;
  await joinWorkerTunnelStops([stopped, stopped.then(drain, drain)]);
}

/** Cancellation is only a request. This acknowledgement joins the node's physical workspace queue. */
export async function drainNodeWorkerWorkspace(
  params: NodeWorkerWorkspaceDrainRequest,
): Promise<void> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(params.timeoutMs),
    ...(params.signal ? [params.signal] : []),
  ]);
  const { transport, node } = await params.findNode(signal);
  const result = await raceNodeWorkerOperation(
    transport.invoke({
      node,
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      params: {
        gatewayNamespace: params.gatewayNamespace,
        environmentId: params.environmentId,
        sessionId: params.sessionId,
        generation: params.ownerEpoch,
        ...(params.deviceFolder === undefined ? {} : { deviceFolder: params.deviceFolder }),
        argv: [NODE_WORKSPACE_DRAIN_COMMAND],
      },
      timeoutMs: params.timeoutMs,
      signal,
      isDispatchAuthorized: params.isAuthorized,
    }),
    signal,
  );
  if (!result.ok) {
    throw new WorkerTunnelOwnerDisconnectedError(
      `Node workspace operations have not drained (${result.error?.code ?? "UNAVAILABLE"}); reconnect the session runner before retrying`,
    );
  }
  if (!params.isAuthorized()) {
    throw new Error("Node workspace drain authority closed");
  }
  const parsed = parseNodeWorkerWorkspaceExecResult(JSON.parse(result.payloadJSON ?? "null"));
  if (parsed?.termination !== "exit" || parsed.code !== 0 || parsed.stdout.trim() !== "drained") {
    throw new Error("Node workspace drain acknowledgement is invalid");
  }
}

/** Retirement authorizes stopping only the exact old environment, never its replacement. */
async function stopNodeWorkerWorkspaceEnvironment(
  params: NodeWorkerWorkspaceDrainRequest,
): Promise<void> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(params.timeoutMs),
    ...(params.signal ? [params.signal] : []),
  ]);
  const { transport, node } = await params.findNode(signal);
  if (node.workerHost.environmentSession !== NODE_WORKER_ENVIRONMENT_SESSION_VERSION) {
    throw createNodeRunnerInventoryIssueError(node.nodeId, NODE_RUNNER_UPDATE_REQUIRED_ISSUE);
  }
  const result = await raceNodeWorkerOperation(
    transport.invoke({
      node,
      command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
      params: {
        gatewayNamespace: params.gatewayNamespace,
        environmentId: params.environmentId,
        sessionId: params.sessionId,
        ownerEpoch: params.ownerEpoch,
      },
      timeoutMs: params.timeoutMs,
      signal,
      isDispatchAuthorized: params.isAuthorized,
    }),
    signal,
  );
  if (!result.ok) {
    const code = result.error?.code ?? "UNAVAILABLE";
    const message = `node worker environment stop failed (${code})`;
    throw RETRYABLE_NODE_WORKER_TRANSPORT_CODES.has(code)
      ? new WorkerTunnelOwnerDisconnectedError(message)
      : new Error(message);
  }
}

/** A restarted Gateway recovers cleanup scope from the durable attachment, not bundle metadata. */
export async function restoreNodeWorkerWorkspaceDrainOwner(
  record: WorkerEnvironmentRecord,
  resolver?: Pick<NodeWorkerWorkspaceBindingResolver, "durableDeviceFolder">,
) {
  if (record.attachedSessionIds.length > 1) {
    throw new Error("node worker environment teardown has an ambiguous session owner");
  }
  const sessionId = record.attachedSessionIds[0];
  if (!sessionId || !record.nodeDeviceId) {
    return undefined;
  }
  // Teardown can run after session and worktree admission closes, so its scope comes from the
  // durable placement only. The node validates the folder again before it acts.
  const deviceFolder = await resolver?.durableDeviceFolder?.({
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    sessionId,
  });
  return {
    deviceId: record.nodeDeviceId,
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    sessionId,
    ...(deviceFolder === undefined ? {} : { deviceFolder }),
    executionMode:
      record.profileSnapshot.executionMode === "remote-exec"
        ? ("remote-exec" as const)
        : ("worker-turn" as const),
  };
}

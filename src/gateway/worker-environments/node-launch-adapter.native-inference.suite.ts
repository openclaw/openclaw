import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import {
  nodeWorkerPlanHash,
  type NodeWorkerLaunchInput,
} from "../../worker/node-supervisor-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createNodeWorkerLaunchAdapter } from "./node-launch-adapter.js";

const DEVICE_ID = "native-inference-device";

function input(): NodeWorkerLaunchInput {
  const bundleHash = "a".repeat(64);
  return {
    environmentSession: 1,
    launchId: "native-turn",
    gatewayNamespace: "gateway-1",
    expectedBundleHash: bundleHash,
    placementGeneration: 4,
    descriptor: {
      version: 4,
      admission: {
        environmentId: "environment-1",
        credential: "synthetic-credential",
        sessionId: "session-1",
        ownerEpoch: 3,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        handshake: {
          bundleHash,
          openclawVersion: "2026.10.1",
          protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
        },
      },
      assignment: {
        agentId: "agent-1",
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        agentRuntimeIdentityToken: "signed-runtime-token",
        runId: "run-1",
        turnId: "native-turn",
        prompt: "Inspect the workspace.",
        suppressPromptTranscript: true,
        workspaceDir: "/tmp/openclaw-worker/workspace",
        modelRef: { provider: "provider-1", model: "model-1" },
        inference: "runtime-local",
        inferenceOptions: {},
        initialMessages: [],
        transcript: { baseLeafId: null, nextSeq: 1 },
        liveEvents: { ackedSeq: 0, nextSeq: 1 },
        toolAuthority: { allowedToolNames: [] },
      },
    },
  };
}

function proof(supported: boolean): NodeWorkerSupervisorNodeProof {
  return {
    nodeId: DEVICE_ID,
    connId: "conn-1",
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: {
      enabled: true,
      capacity: { total: 1, available: 1 },
      environmentSession: 1,
      capturedExecPolicy: true,
      ...(supported ? { nativeInference: 1 as const } : {}),
    },
    commands: ["system.run"],
  };
}

export function registerNodeLaunchAdapterNativeInferenceSuite() {
  it.each([false, true])(
    "requires a node-host native inference handoff for runtime-local assignments: %s",
    async (supported) => {
      const launchInput = input();
      const node = proof(supported);
      const completed = {
        launchId: launchInput.launchId,
        planHash: nodeWorkerPlanHash(launchInput),
        environmentId: launchInput.descriptor.admission.environmentId,
        sessionId: launchInput.descriptor.admission.sessionId,
        ownerEpoch: launchInput.descriptor.admission.ownerEpoch,
        placementGeneration: launchInput.placementGeneration,
        runId: launchInput.descriptor.assignment.runId,
        state: "completed" as const,
        resultJson: JSON.stringify({ status: "completed" }),
      };
      const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
        ok: true,
        payloadJSON: JSON.stringify(completed),
      }));
      const transport: NodeWorkerSupervisorTransport = {
        invoke,
        isCurrent: () => true,
        getCurrentNode: async () => node,
        listCurrentNodes: async () => [node],
        hasCurrentRunner: () => true,
      };
      const launch = createNodeWorkerLaunchAdapter({ getTransport: () => transport }).launch({
        deviceId: DEVICE_ID,
        input: launchInput,
        isDispatchAuthorized: () => true,
        isCancellationAuthorized: () => true,
        timeoutMs: 10_000,
      });
      if (supported) {
        await expect(launch).resolves.toEqual(completed);
        expect(invoke).toHaveBeenCalledOnce();
      } else {
        await expect(launch).rejects.toMatchObject({
          name: "NodeRunnerUpdateRequiredError",
          code: "node_runner_update_required",
          message: expect.stringMatching(
            /requires an update.*openclaw update.*reconnect.*openclaw node restart/su,
          ),
        });
        expect(invoke).not.toHaveBeenCalled();
      }
    },
  );
}

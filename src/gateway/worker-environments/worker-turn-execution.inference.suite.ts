import { expect, it, vi } from "vitest";
import { WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  completeWorkerLaunchDescriptor,
  type WorkerLaunchPlan,
} from "../../worker/launch-descriptor.js";
import { roundTripWorkerLaunchDescriptor } from "../../worker/launch-descriptor.test-support.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  credential,
  placements,
  seedActivePlacement,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

export function registerWorkerTurnInferenceTests(): void {
  it.each([
    ...[undefined, "gateway", "worker"].map((inference) => ({
      providerId: "device",
      inference,
    })),
    ...[false, null, { mode: "remote" }, "worker"].map((inference) => ({
      providerId: "custom-provider",
      inference,
    })),
  ])(
    "dispatches a registered worker turn with provider-owned inference %j",
    async ({ providerId, inference }) => {
      await seedActivePlacement();
      const environment = attachedEnvironment();
      environment.providerId = providerId;
      environment.nodeDeviceId = "paired-inference-node";
      environment.sshEndpoint = null;
      environment.profileSnapshot = { settings: inference === undefined ? {} : { inference } };
      environment.bootstrapReceipt!.protocolFeatures.push(WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE);
      let descriptor: WorkerLaunchPlan | undefined;
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
        descriptor = roundTripWorkerLaunchDescriptor(
          completeWorkerLaunchDescriptor(plan, {
            kind: "unix",
            socketPath: "/tmp/worker-local-inference.sock",
          }),
        );
        throw new WorkerRunnerCapacityError();
      });
      const tunnel = createWorkerTurnTunnel({
        launchTurn,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      });
      const environments = {
        ...unusedEnvironments(),
        get: vi.fn(() => environment),
        acquireTurnCredential: vi.fn(async () => credential()),
        startTunnel: vi.fn(async () => tunnel),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const runLocal = vi.fn();
      const params = turn("run-inference-placement");
      const baseUrl = "https://gateway-inference.example.test/v1";
      const apiKey = ["synthetic", "gateway", "inference", "fixture"].join("-");
      const workerLocal = providerId === "device" && inference === "worker";
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: params.runId,
          },
          {
            ...params,
            config: {
              ...params.config,
              models: {
                providers: {
                  openai: {
                    baseUrl,
                    ...(!workerLocal ? { apiKey } : {}),
                    api: "openai-completions",
                    models: [
                      {
                        id: params.model,
                        name: params.model,
                        reasoning: false,
                        input: ["text"],
                        contextWindow: 8192,
                        maxTokens: 2048,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      },
                    ],
                  },
                },
              },
            },
          },
          runLocal,
        ),
      ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);

      expect(launchTurn).toHaveBeenCalledOnce();
      expect(environments.acquireTurnCredential).toHaveBeenCalledOnce();
      expect(environments.startTunnel).toHaveBeenCalledOnce();
      expect(runLocal).not.toHaveBeenCalled();
      expect(descriptor?.assignment.modelRef).toEqual({
        provider: params.provider,
        model: params.model,
      });
      if (workerLocal) {
        expect(descriptor?.assignment.inference).toBe("runtime-local");
      } else {
        expect(descriptor?.assignment).not.toHaveProperty("inference");
      }
      expect(descriptor?.assignment).not.toHaveProperty("baseUrl");
      expect(descriptor?.assignment).not.toHaveProperty("apiKey");
      expect(JSON.stringify(descriptor)).not.toContain(baseUrl);
      expect(JSON.stringify(descriptor)).not.toContain(apiKey);
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    },
  );

  it.each(["missing-feature", "missing-node", "model-policy"] as const)(
    "rejects worker inference %s before credential, tunnel, or dispatch without local fallback",
    async (rejection) => {
      await seedActivePlacement();
      const environment = attachedEnvironment();
      environment.providerId = "device";
      environment.nodeDeviceId = rejection === "missing-node" ? null : "paired-inference-node";
      environment.sshEndpoint = null;
      environment.profileSnapshot = { settings: { inference: "worker" } };
      if (rejection !== "missing-feature") {
        environment.bootstrapReceipt!.protocolFeatures.push(
          WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE,
        );
      }
      const environments = {
        ...unusedEnvironments(),
        get: vi.fn(() => environment),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const runLocal = vi.fn();
      const onExecutionPhase = vi.fn();
      const params = turn("run-rejected-local-inference");
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: params.runId,
          },
          {
            ...params,
            ...(rejection === "model-policy"
              ? {
                  config: {
                    ...params.config,
                    agents: {
                      defaults: {
                        ...params.config.agents.defaults,
                        modelPolicy: { allow: ["openai/gpt-approved-only"] },
                      },
                    },
                  },
                }
              : {}),
            onExecutionPhase,
          },
          runLocal,
        ),
      ).rejects.toThrow(
        rejection === "model-policy"
          ? "Allow that model in the agent model policy"
          : rejection === "missing-node"
            ? "settings.device to a connected node"
            : "Update and restart its OpenClaw node host",
      );
      expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(onExecutionPhase).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    },
  );
}

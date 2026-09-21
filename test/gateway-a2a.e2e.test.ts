import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { startQaMockOpenAiServer } from "../extensions/qa-lab/api.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

test("A2A completes correlated tasks under message-tool-only source policy", async () => {
  const model = await startQaMockOpenAiServer({ modelRefs: ["a2a-proof/a2a-proof"] });
  let instance: OpenClawTestInstance | undefined;
  await runQaGatewayFixture(
    async () => {
      instance = await createOpenClawTestInstance({
        name: "a2a-correlated-replies",
        config: {
          plugins: { allow: ["a2a", "openai"], slots: { memory: "none" } },
          agents: {
            defaults: {
              heartbeat: { every: "0m" },
              model: { primary: "a2a-proof/a2a-proof" },
              models: { "a2a-proof/a2a-proof": { agentRuntime: { id: "openclaw" } } },
              skipBootstrap: true,
              skills: [],
            },
          },
          tools: { profile: "minimal", alsoAllow: ["message"] },
          messages: { visibleReplies: "message_tool" },
          channels: {
            a2a: {
              enabled: true,
              rateLimitPerMinute: 0,
              peers: {
                hermes: { token: "a2a-hermes-test-token" },
                crew: { token: "a2a-crew-test-token" },
              },
            },
          },
          models: {
            mode: "replace",
            providers: {
              "a2a-proof": {
                baseUrl: `${model.baseUrl}/v1`,
                apiKey: "a2a-model-test-token",
                api: "openai-responses",
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: "a2a-proof",
                    name: "A2A proof",
                    api: "openai-responses",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
        env: {
          OPENCLAW_SKIP_CHANNELS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      await instance.startGateway();
      const endpoint = `http://127.0.0.1:${instance.port}/a2a/v1`;
      const rpc = async (method: string, params: unknown, token: string) =>
        fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
        });
      expect((await rpc("GetTask", { id: "unknown" }, "wrong-token")).status).toBe(401);

      const contextId = "shared-peer-context";
      const completeTask = async (peer: string) => {
        const token = `a2a-${peer}-test-token`;
        const text = `A2A-${peer.toUpperCase()}-COMPLETE`;
        const response = await rpc(
          "SendMessage",
          {
            message: {
              messageId: randomUUID(),
              contextId,
              role: "ROLE_USER",
              parts: [{ text: `Reply exactly \`${text}\`` }],
            },
            configuration: { returnImmediately: true },
          },
          token,
        );
        expect(response.status).toBe(200);
        const accepted = await response.json();
        expect(accepted.result.task.status.state).toBe("TASK_STATE_WORKING");
        const taskId = accepted.result.task.id;
        await expect
          .poll(async () => (await (await rpc("GetTask", { id: taskId }, token)).json()).result, {
            timeout: 30_000,
          })
          .toMatchObject({
            id: taskId,
            contextId,
            status: { state: "TASK_STATE_COMPLETED" },
            artifacts: [{ parts: [{ text }] }],
          });
        return taskId;
      };
      const [hermesTask, crewTask] = await Promise.all([
        completeTask("hermes"),
        completeTask("crew"),
      ]);
      expect(hermesTask).not.toBe(crewTask);
      const denied = await rpc("GetTask", { id: hermesTask }, "a2a-crew-test-token");
      expect(await denied.json()).toMatchObject({ error: { code: -32001 } });
    },
    () => instance?.cleanup(),
    () => model.stop(),
  );
}, 120_000);

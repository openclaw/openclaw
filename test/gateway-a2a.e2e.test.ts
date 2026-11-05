import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { startQaMockOpenAiServer } from "../extensions/qa-lab/api.js";
import { createOpenAiResponsesModelConfig } from "./helpers/openai-responses-model-fixture.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

test("A2A correlates tasks under message-tool-only policy", async ({ onTestFinished }) => {
  const model = await startQaMockOpenAiServer({ modelRefs: ["a2a-proof/a2a-proof"] });
  let cleanupGateway = async () => {};
  onTestFinished(() => runQaGatewayFixture(cleanupGateway, () => model.stop()));
  const instance = await createOpenClawTestInstance({
    name: "a2a-correlated-replies",
    config: {
      ...createOpenAiResponsesModelConfig({
        baseUrl: model.baseUrl,
        providerId: "a2a-proof",
        modelId: "a2a-proof",
        reasoning: false,
        toolProfile: "minimal",
      }),
      plugins: { allow: ["a2a", "openai"], slots: { memory: "none" } },
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
    },
    env: {
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    },
  });
  cleanupGateway = () => instance.cleanup();
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
  const [hermesTask, crewTask] = await Promise.all([completeTask("hermes"), completeTask("crew")]);
  expect(hermesTask).not.toBe(crewTask);
  const denied = await rpc("GetTask", { id: hermesTask }, "a2a-crew-test-token");
  expect(await denied.json()).toMatchObject({ error: { code: -32001 } });
}, 120_000);

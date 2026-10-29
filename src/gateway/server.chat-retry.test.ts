import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, expect, it } from "vitest";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { collectTextContentBlocks } from "../agents/content-blocks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { createTrackedProvider } from "./test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const sessionKey = "agent:retry:main";
const continuation = "Continue from where you stopped.";
const requests: Record<string, unknown>[] = [];
let home: Awaited<ReturnType<typeof setupGatewayTempHome>>;
let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;
let provider: ReturnType<typeof createTrackedProvider>;

const messageText = (message: unknown) =>
  !isRecord(message)
    ? ""
    : typeof message.content === "string"
      ? message.content
      : collectTextContentBlocks(message.content).join("\n");

beforeAll(async () => {
  resetGatewayTestState();
  home = await setupGatewayTempHome({ prefix: "openclaw-chat-retry-" });
  provider = createTrackedProvider((raw, response) => {
    requests.push(JSON.parse(raw));
    // Every attempt of the original run fails; only the Try again continuation answers.
    const failed = !raw.includes(continuation);
    const item = {
      type: "message",
      id: `reply-${requests.length}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Recovered answer.", annotations: [] }],
    };
    writeOpenAiResponsesSse(response, [
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: failed ? "response.failed" : "response.completed",
        response: {
          id: `response-${requests.length}`,
          status: failed ? "failed" : "completed",
          output: failed ? [] : [item],
          usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 },
          ...(failed ? { error: { code: null, message: "Internal server error" } } : {}),
        },
      },
    ]);
  });
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
  const mock = buildMockOpenAiResponsesProvider(await provider.listen());
  mock.config.models[0].maxTokens = 256;
  const agentDir = path.join(home.tempHome, ".openclaw", "agents", "retry", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ retry: { provider: { maxRetries: 1 } } }),
  );
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { workspace: home.workspaceDir, skipBootstrap: true, utilityModel: "" },
      entries: { retry: { model: { primary: `openai/${mock.modelId}`, fallbacks: [] } } },
    },
    plugins: {
      allow: ["openai"],
      slots: { memory: "none" },
      entries: { openai: { enabled: true } },
    },
    models: { mode: "replace", providers: { openai: mock.config } },
  };
  gateway = await startGatewayWithClient({
    cfg: config,
    configPath: await createGatewayConfigPath(home.tempHome),
    token: "chat-retry-test",
  });
}, 90_000);

afterAll(async () => {
  try {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close();
    }
  } finally {
    await provider?.close();
    if (home) {
      home.envSnapshot.restore();
      await removeGatewayTempHome(home.tempHome);
    }
    resetGatewayTestState();
  }
});

it("continues a failed run with hidden input and retires its failure notice", async () => {
  const { runId } = await gateway.client.request<{ runId: string }>("chat.send", {
    sessionKey,
    message: "What is the answer?",
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  const failed = await gateway.client.request<{ status: string }>(
    "agent.wait",
    { runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  );
  expect(failed.status).toBe("error");
  const before = await gateway.client.request<{ sessionId: string; messages: unknown[] }>(
    "chat.history",
    { sessionKey, limit: 20 },
  );
  expect(
    before.messages.filter(isRecord).map((message) => message.openclawRunError),
  ).toContainEqual({ runId, summary: expect.stringMatching(/\S/) });

  const idempotencyKey = randomUUID();
  const retry = { sessionKey, sessionId: before.sessionId, runId, idempotencyKey };
  const ack = await gateway.client.request<{ runId: string; status: string }>("chat.retry", retry);
  expect(ack).toMatchObject({ runId: idempotencyKey, status: "started" });
  const completed = await gateway.client.request<{ status: string }>(
    "agent.wait",
    { runId: ack.runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  );
  expect(completed.status).toBe("ok");
  // The model receives the continuation after the failed turn, not a replay of the prompt.
  expect(JSON.stringify(requests.at(-1)?.input)).toContain(continuation);

  const after = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
    sessionKey,
    limit: 20,
  });
  const visible = after.messages.filter(isRecord);
  expect(visible.some((message) => message.openclawRunError)).toBe(false);
  expect(visible.map(messageText).some((text) => text.includes(continuation))).toBe(false);
  expect(visible.filter((message) => message.role === "user").map(messageText)).toEqual([
    "What is the answer?",
  ]);
  expect(messageText(visible.at(-1))).toBe("Recovered answer.");

  // The failed run is no longer the latest; a second Try again cannot replay it.
  await expect(
    gateway.client.request("chat.retry", { ...retry, idempotencyKey: randomUUID() }),
  ).rejects.toThrow(/changed before it could be retried/u);
}, 120_000);

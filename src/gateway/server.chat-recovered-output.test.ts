import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import {
  replayChatDisplay,
  type ChatDisplayFrame,
} from "../../test/helpers/gateway/chat-display-replay.js";
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

const prefix = "The answer is";
const answer = "The answer is 42.";
const scenarios = ["continuation", "fallback", "terminal", "no-fallback", "settled-write"];
const requests = new Map<string, Record<string, unknown>[]>();
const displayFrames: ChatDisplayFrame[] = [];
let home: Awaited<ReturnType<typeof setupGatewayTempHome>>;
let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;
let provider: ReturnType<typeof createTrackedProvider>;

function messageText(message: unknown): string {
  return isRecord(message) ? collectTextContentBlocks(message.content).join("\n") : "";
}

function assistantTexts(messages: unknown[]): string[] {
  return messages
    .filter(isRecord)
    .filter((message) => message.role === "assistant")
    .map(messageText);
}

function publishedMessages(sessionKey: string): unknown[] {
  return displayFrames.flatMap(({ event, payload }) =>
    event === "session.message" && isRecord(payload) && payload.sessionKey === sessionKey
      ? [payload.message]
      : [],
  );
}

function writeResponse(response: ServerResponse, model: string, attempt: number): void {
  const writeTool = model === "settled-write" && attempt === 1;
  const failed =
    ["fallback", "terminal", "terminal-fallback", "no-fallback"].includes(model) ||
    (model === "continuation" && attempt === 1) ||
    (model === "settled-write" && attempt === 2);
  const text = failed ? prefix : answer;
  const item = writeTool
    ? {
        type: "function_call",
        id: "write-effect",
        call_id: "write-effect",
        name: "exec",
        arguments: JSON.stringify({
          command:
            "node -e \"require('node:fs').appendFileSync('effect.txt', 'effect' + String.fromCharCode(10))\"",
          workdir: home.workspaceDir,
        }),
      }
    : {
        type: "message",
        id: `${model}-${attempt}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: writeTool
        ? { ...item, arguments: "" }
        : { ...item, content: [], status: "in_progress" },
    },
    writeTool
      ? { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments }
      : {
          type: "response.output_text.delta",
          output_index: 0,
          item_id: item.id,
          content_index: 0,
          delta: text,
        },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: failed ? "response.failed" : "response.completed",
      response: {
        id: `response-${model}-${attempt}`,
        status: failed ? "failed" : "completed",
        output: [item],
        usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 },
        ...(failed ? { error: { code: null, message: "Internal server error" } } : {}),
      },
    },
  ]);
}

beforeAll(async () => {
  resetGatewayTestState();
  home = await setupGatewayTempHome({ prefix: "openclaw-recovered-output-" });
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
  provider = createTrackedProvider((raw, response, request) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const payload: Record<string, unknown> = JSON.parse(raw);
    if (typeof payload.model !== "string") {
      throw new Error("Responses request has no model");
    }
    const attempts = requests.get(payload.model) ?? [];
    attempts.push(payload);
    requests.set(payload.model, attempts);
    writeResponse(response, payload.model, attempts.length);
  });
  const baseUrl = await provider.listen();
  const providerConfig = buildMockOpenAiResponsesProvider(baseUrl).config;
  const models = [...scenarios, "recovered", "terminal-fallback"].map((id) => {
    const model = buildMockOpenAiResponsesProvider(baseUrl, id).config.models[0];
    model.maxTokens = 256;
    return model;
  });
  const entries: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]> = {};
  const fallbacks: Record<string, string[]> = {
    fallback: ["openai/recovered"],
    terminal: ["openai/terminal-fallback"],
  };
  for (const scenario of scenarios) {
    entries[scenario] = {
      model: {
        primary: `openai/${scenario}`,
        fallbacks: fallbacks[scenario] ?? [],
      },
    };
    const agentDir = path.join(home.tempHome, ".openclaw", "agents", scenario, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ retry: { provider: { maxRetries: 1 } } }),
    );
  }
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { workspace: home.workspaceDir, skipBootstrap: true, utilityModel: "" },
      entries,
    },
    plugins: {
      allow: ["openai"],
      slots: { memory: "none" },
      entries: { openai: { enabled: true } },
    },
    models: {
      mode: "replace",
      providers: {
        openai: {
          ...providerConfig,
          models,
        },
      },
    },
  };
  gateway = await startGatewayWithClient({
    cfg: config,
    configPath: await createGatewayConfigPath(home.tempHome),
    token: "recovery-test",
    onEvent: (event) => {
      const payload = event.payload;
      if (event.event === "chat") {
        displayFrames.push({ event: "chat", payload: payload as ChatEvent });
      }
      if (event.event === "session.message") {
        displayFrames.push({ event: "session.message", payload });
      }
    },
  });
}, 90_000);

afterAll(async () => {
  try {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close();
    }
  } finally {
    if (provider) {
      await provider.close();
    }
    if (home) {
      home.envSnapshot.restore();
      await removeGatewayTempHome(home.tempHome);
    }
    resetGatewayTestState();
  }
});

it.each(scenarios)(
  "Responses HTTP chat.send retains only the selected output after %s",
  async (scenario) => {
    const sessionKey = `agent:${scenario}:main`;
    await gateway.client.request("sessions.messages.subscribe", { key: sessionKey });
    const { runId } = await gateway.client.request<{ runId: string }>("chat.send", {
      sessionKey,
      message: "What is the answer?",
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    const completed = await gateway.client.request<{
      status: string;
      terminalReply?: { text?: string };
    }>("agent.wait", { runId, timeoutMs: 60_000 }, { timeoutMs: 65_000 });
    const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
      sessionKey,
      limit: 20,
    });
    const failed = scenario === "terminal" || scenario === "no-fallback";
    const terminal = displayFrames.flatMap((frame) =>
      frame.event === "chat" &&
      frame.payload.runId === runId &&
      ["final", "error"].includes(frame.payload.state)
        ? [frame.payload]
        : [],
    );
    if (failed) {
      expect(completed.status).toBe("error");
      for (const messages of [history.messages, publishedMessages(sessionKey)]) {
        const records = messages.filter(isRecord);
        const partial = records.findLast((message) => message.role === "assistant");
        expect(messageText(partial)).toBe(prefix);
        expect(partial).not.toHaveProperty("stopReason");
        expect(partial).not.toHaveProperty("openclawRunError");
      }
      // Terminal failures publish chat.error after persistence; custom receipts live in history.
      const notices = history.messages
        .filter(isRecord)
        .filter((message) => message.customType === "run-failed-before-reply");
      expect(notices, "durable terminal failure receipt").toHaveLength(1);
      expect(notices[0]).toMatchObject({
        role: "custom",
        openclawRunError: { runId, summary: expect.stringMatching(/\S/) },
      });
      expect(terminal).toMatchObject([
        {
          runId,
          state: "error",
          errorMessage: expect.stringMatching(/\S/),
        },
      ]);
      const display = replayChatDisplay(displayFrames, sessionKey, runId);
      expect(display).toMatchObject({
        chatRunId: null,
        chatStream: null,
        chatStreamSegments: [],
      });
      expect(assistantTexts(display.chatMessages)).toEqual(assistantTexts(history.messages));
    } else {
      expect(completed).toMatchObject({ status: "ok", terminalReply: { text: answer } });
      expect(messageText(history.messages.at(-1))).toBe(answer);
      expect(
        terminal.filter((event) => "message" in event && messageText(event.message) === answer),
      ).toHaveLength(1);
      expect(
        terminal.some(
          (event) => "message" in event && messageText(event.message).includes(`${prefix}\n`),
        ),
      ).toBe(false);
    }
    expect(requests.get(scenario)).toHaveLength(scenario === "settled-write" ? 3 : 2);
    if (scenario === "fallback") {
      expect(requests.get("recovered")).toHaveLength(1);
    }
    if (scenario === "terminal") {
      expect(requests.get("terminal-fallback")).toHaveLength(2);
    }
    if (scenario === "settled-write") {
      expect(await fs.readFile(path.join(home.workspaceDir, "effect.txt"), "utf8")).toBe(
        "effect\n",
      );
      expect(JSON.stringify(requests.get(scenario)?.at(-1)?.input)).toContain(
        "function_call_output",
      );
    }
  },
  90_000,
);

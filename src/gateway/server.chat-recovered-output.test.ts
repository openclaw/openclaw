import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const prefix = "The answer is";
const answer = "The answer is 42.";
const scenarios = ["continuation", "fallback", "terminal", "no-fallback", "settled-write"];
const requests = new Map<string, Record<string, unknown>[]>();
const events: ChatEvent[] = [];
let home: Awaited<ReturnType<typeof setupGatewayTempHome>>;
let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;
let provider: ReturnType<typeof createServer>;

function messageText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
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
    ...(writeTool
      ? [{ type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments }]
      : [
          {
            type: "response.output_text.delta",
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            delta: text,
          },
        ]),
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

describe("registered chat.send recovered output over Responses HTTP", () => {
  beforeAll(async () => {
    resetGatewayTestState();
    home = await setupGatewayTempHome({ prefix: "openclaw-recovered-output-" });
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
    provider = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        const payload: Record<string, unknown> = JSON.parse(body);
        if (typeof payload.model !== "string") {
          throw new Error("Responses request has no model");
        }
        const attempts = requests.get(payload.model) ?? [];
        attempts.push(payload);
        requests.set(payload.model, attempts);
        writeResponse(response, payload.model, attempts.length);
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
    });
    await new Promise<void>((resolve) => {
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("Responses fixture did not bind");
    }
    const entries: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]> = {};
    for (const scenario of scenarios) {
      entries[scenario] = {
        model: {
          primary: `openai/${scenario}`,
          fallbacks:
            scenario === "fallback"
              ? ["openai/recovered"]
              : scenario === "terminal"
                ? ["openai/terminal-fallback"]
                : [],
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
        defaults: { workspace: home.workspaceDir, skipBootstrap: true },
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
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "test",
            api: "openai-responses",
            models: [...scenarios, "recovered", "terminal-fallback"].map((id) => ({
              id,
              name: id,
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 256,
            })),
          },
        },
      },
    };
    gateway = await startGatewayWithClient({
      cfg: config,
      configPath: await createGatewayConfigPath(home.tempHome),
      token: "recovery-test",
      onEvent: (event) => {
        if (event.event === "chat") {
          events.push(event.payload as ChatEvent);
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
        provider.closeAllConnections();
        await new Promise<void>((resolve) => {
          provider.close(() => resolve());
        });
      }
      if (home) {
        home.envSnapshot.restore();
        await removeGatewayTempHome(home.tempHome);
      }
      resetGatewayTestState();
    }
  });

  it.each(scenarios)(
    "chat.send retains only the selected output after %s",
    async (scenario) => {
      const sessionKey = `agent:${scenario}:main`;
      const started = await gateway.client.request<{ runId: string }>("chat.send", {
        sessionKey,
        message: "What is the answer?",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      const completed = await gateway.client.request<{
        status: string;
        terminalReply?: { text?: string };
      }>("agent.wait", { runId: started.runId, timeoutMs: 60_000 }, { timeoutMs: 65_000 });
      const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey,
        limit: 20,
      });
      const failed = scenario === "terminal" || scenario === "no-fallback";
      const terminal = events.filter(
        (event) => event.runId === started.runId && ["final", "error"].includes(event.state),
      );
      if (failed) {
        expect(completed.status).toBe("error");
        expect(messageText(history.messages.at(-1))).toBe(prefix);
        expect(terminal.some((event) => event.state === "error")).toBe(true);
        const deltas = events.filter(
          (event): event is Extract<ChatEvent, { state: "delta" }> =>
            event.runId === started.runId && event.state === "delta",
        );
        expect(messageText(deltas.at(-1)?.message)).toBe(prefix);
      } else {
        expect(completed.status).toBe("ok");
        expect(completed.terminalReply?.text).toBe(answer);
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
});

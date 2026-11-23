import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text as readText } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anthropicTextTurn } from "../../test/anthropic-text-turn.test-support.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayTestState } from "../gateway/gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../gateway/test-helpers.e2e.js";
import { createAuthorityGatewayTestEnv } from "../gateway/test-helpers.env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import type { CronJob, CronJobCreate } from "./types.js";

// A scheduled reply must reach the model once: its own turn already holds it in the
// conversation. Only the provider endpoint is synthetic; Gateway, cron and sessions are real.
type Api = "openai-responses" | "anthropic-messages";
type Turn = { role: string; text: string };

const REPLY = "SCHEDULED_REPLY_42";

// Normalizes Responses input items and Anthropic messages to role/text pairs.
function readTurns(api: Api, body: Record<string, unknown>): Turn[] {
  const items = (api === "openai-responses" ? body.input : body.messages) as unknown[];
  return items.flatMap((item) => {
    const record = item as { role?: string; content?: unknown };
    if (!record.role) {
      return [];
    }
    const content = Array.isArray(record.content)
      ? (record.content as { text?: string }[]).map((block) => block.text ?? "").join("")
      : typeof record.content === "string"
        ? record.content
        : "";
    return [{ role: record.role, text: content }];
  });
}

// The current turn is every user item after the last assistant reply.
function replyFor(turns: Turn[]): string {
  const current = turns.slice(turns.findLastIndex((turn) => turn.role === "assistant") + 1);
  return current.some((turn) => turn.text.includes("SCHEDULED_TICK")) ? REPLY : "OK";
}

describe.each<Api>(["openai-responses", "anthropic-messages"])("%s", (api) => {
  const requests: Turn[][] = [];
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let endpoint: ReturnType<typeof createServer>;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: `cron-single-copy-${api}`,
      env: {
        ...createAuthorityGatewayTestEnv(),
        OPENCLAW_SKIP_CRON: undefined,
        // Keep the synthetic provider local on hosts with an HTTP proxy.
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
      },
    });
    endpoint = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const turns = readTurns(api, JSON.parse(await readText(request)));
        requests.push(turns);
        const text = replyFor(turns);
        if (api === "openai-responses") {
          writeOpenAiResponsesText(response, {
            text,
            messageId: `msg-${requests.length}`,
            responseId: `resp-${requests.length}`,
          });
        } else {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(anthropicTextTurn("fixture", text, `msg-${requests.length}`, 100, 5));
        }
      })().catch((error: unknown) => response.destroy(error as Error));
    });
    await once(endpoint.listen(0, "127.0.0.1"), "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Provider fixture did not bind a TCP port");
    }
    const token = "synthetic-cron-single-copy-token";
    const modelRef = "fixture/fixture";
    const cfg = {
      gateway: { mode: "local", auth: { mode: "token", token }, reload: { mode: "off" } },
      agents: {
        entries: { main: {} },
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: modelRef, fallbacks: [] },
          models: {
            [modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
          compaction: { memoryFlush: { enabled: false } },
        },
      },
      models: {
        mode: "replace",
        catalogRefresh: { enabled: false },
        providers: {
          fixture: {
            api,
            baseUrl: `http://127.0.0.1:${address.port}${api === "openai-responses" ? "/v1" : ""}`,
            apiKey: "synthetic-provider-key",
            request: { allowPrivateNetwork: true },
            models: [modelDefinition("fixture", { api, reasoning: false, maxTokens: 256 })],
          },
        },
      },
      tools: { allow: ["read"], codeMode: false, toolSearch: false },
      plugins: { enabled: false, slots: { memory: "none" } },
      cron: { enabled: false },
      update: { checkOnStart: false },
    } satisfies OpenClawConfig;
    gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
    await gateway.server.startupSettled;
  }, 180_000);

  afterAll(async () => {
    try {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "cron single copy proof complete" });
      }
    } finally {
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => {
        endpoint.close(() => resolve());
      });
      await state.cleanup();
      resetGatewayTestState();
    }
  }, 60_000);

  async function send(sessionKey: string, message: string) {
    const before = requests.length;
    const started = await gateway.client.request<{ runId: string }>("chat.send", {
      sessionKey,
      message,
      idempotencyKey: randomUUID(),
      deliver: false,
    });
    await expect(
      gateway.client.request("agent.wait", { runId: started.runId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "ok" });
    return requests.slice(before);
  }

  async function runCron(job: Partial<CronJobCreate>) {
    const created = await gateway.client.request<CronJob>("cron.add", {
      name: `single-copy-${randomUUID()}`,
      agentId: "main",
      enabled: false,
      schedule: { kind: "every", everyMs: 3_600_000 },
      wakeMode: "now",
      ...job,
    });
    await gateway.client.request("cron.run", { id: created.id, mode: "force" });
    await expect
      .poll(
        async () =>
          (
            await gateway.client.request<{ entries: CronRunLogEntry[] }>("cron.runs", {
              id: created.id,
              limit: 1,
            })
          ).entries[0]?.status,
        { timeout: 30_000 },
      )
      .toBe("ok");
  }

  // Model copies of the scheduled reply two user turns later, and display rows. A misplaced
  // copy lands after the first follow-up, where Anthropic drops it as a trailing assistant turn.
  async function observe(sessionKey: string, backgroundResult = false) {
    await send(sessionKey, "First follow-up.");
    const next = await send(sessionKey, "Second follow-up.");
    const history = await gateway.client.request<{ messages: Record<string, unknown>[] }>(
      "chat.history",
      { sessionKey, limit: 100 },
    );
    const shown = history.messages.filter(
      (message) =>
        message.role === "assistant" &&
        message.display !== false &&
        JSON.stringify(message.content).includes(REPLY),
    );
    const modelTurns = next.at(-1);
    if (backgroundResult) {
      expect(modelTurns?.filter((turn) => turn.text.includes(REPLY))).toEqual([
        expect.objectContaining({
          role: "user",
          text: expect.stringContaining(
            "[OpenClaw background result] You sent the message below to the user in this chat from a separate background run.",
          ),
        }),
      ]);
    }
    return {
      // Background results replay as user input; Anthropic can merge adjacent turns.
      // Count text occurrences across both roles, not the number of turns.
      modelCopies: modelTurns
        ?.filter((turn) => turn.role === "assistant" || turn.role === "user")
        .reduce((sum, turn) => sum + turn.text.split(REPLY).length - 1, 0),
      displayRows: shown.length,
    };
  }

  const payload = { kind: "agentTurn" as const, message: "SCHEDULED_TICK. Reply with the marker." };

  it("session-target cron reply reaches the next request once and shows once", async () => {
    const sessionKey = `agent:main:target-${randomUUID()}`;
    await send(sessionKey, "Hello.");
    await runCron({ sessionTarget: `session:${sessionKey}`, payload, delivery: { mode: "none" } });
    await expect(observe(sessionKey)).resolves.toEqual({ modelCopies: 1, displayRows: 1 });
  }, 60_000);

  it("main-session systemEvent cron reply reaches the next request once", async () => {
    const sessionKey = "agent:main:main";
    await send(sessionKey, "Hello.");
    await runCron({
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "SCHEDULED_TICK. Reply with the marker." },
    });
    await expect(observe(sessionKey)).resolves.toEqual({ modelCopies: 1, displayRows: 1 });
  }, 60_000);

  it("isolated cron leaves an unrelated chat unchanged", async () => {
    const sessionKey = `agent:main:bystander-${randomUUID()}`;
    await send(sessionKey, "Hello.");
    await runCron({ sessionTarget: "isolated", payload, delivery: { mode: "none" } });
    await expect(observe(sessionKey)).resolves.toEqual({ modelCopies: 0, displayRows: 0 });
  }, 60_000);

  it("isolated cron created from a chat keeps its result placement there", async () => {
    const sessionKey = `agent:main:creator-${randomUUID()}`;
    await send(sessionKey, "Hello.");
    await runCron({ sessionTarget: "isolated", sessionKey, payload });
    await expect(observe(sessionKey, true)).resolves.toEqual({ modelCopies: 1, displayRows: 1 });
  }, 60_000);
});

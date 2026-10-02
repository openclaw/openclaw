import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { text as readText } from "node:stream/consumers";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import { expect, it } from "vitest";
import {
  DEFAULT_MISSING_TOOL_RESULT_TEXT,
  makeMissingToolResult,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AssistantMessage } from "../../llm/types.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

function readStoredRows(storePath: string, sessionId: string) {
  const database = new DatabaseSync(storePath, { readOnly: true });
  try {
    // Inspect the stored bytes, including diagnostics omitted from model context.
    return database
      .prepare(
        "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId);
  } finally {
    database.close();
  }
}

// Routing project: gateway-database-workers; no session, handler, or transport mocks.
it("chat.send replays synthetic repairs through session history and the registered messages transport", async () => {
  const state = await createOpenClawTestState({
    label: "chat-send-synthetic-repair",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
  });
  const provider = "replay-fixture";
  const model = "replay-proof";
  const modelRef = `${provider}/${model}`;
  const requests: MessageCreateParamsStreaming[] = [];
  const providerWork: Promise<void>[] = [];
  const endpoint = createServer((request, response) => {
    const work = (async () => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/messages");
      requests.push(JSON.parse(await readText(request)));
      const events = [
        {
          type: "message_start",
          message: {
            id: "replay-message",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "REPLAY_SETTLED" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
    })();
    providerWork.push(work);
    void work.catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Replay fixture did not bind a TCP port");
    }
    const token = "synthetic-replay-gateway-token";
    const cfg = {
      gateway: {
        mode: "local",
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        reload: { mode: "off" },
      },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: modelRef, fallbacks: [] },
          models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
          heartbeat: { every: "0m" },
        },
      },
      models: {
        mode: "replace",
        catalogRefresh: { enabled: false },
        providers: {
          [provider]: {
            api: "anthropic-messages",
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: "synthetic-replay-provider-key",
            models: [
              {
                id: model,
                name: "Replay proof",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 64000,
                maxTokens: 256,
              },
            ],
          },
        },
      },
      plugins: { allow: ["anthropic"], slots: { memory: "none" } },
      skills: { allowBundled: [] },
      tools: { allow: ["read"] },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    const { client, server } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
    try {
      await server.startupSettled;
      for (const legacy of [false, true]) {
        for (const late of [false, true]) {
          const scenario = `legacy=${legacy}, late=${late}`;
          const sessionId = randomUUID();
          const sessionKey = `agent:main:replay-${sessionId}`;
          const target = {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
          };
          await upsertSessionEntry({
            ...target,
            entry: { sessionId, updatedAt: Date.now(), modelProvider: provider, model },
          });
          const manager = SessionManager.open(target, state.workspaceDir);
          const timestamp = Date.now();
          const assistant = (
            content: AssistantMessage["content"],
            stopReason: AssistantMessage["stopReason"] = "stop",
          ) =>
            makeAssistantMessageFixture({
              provider,
              api: "anthropic-messages",
              model,
              timestamp,
              stopReason,
              errorMessage: undefined,
              content,
            });
          manager.appendMessage(makeUserMessage("Check service health.", timestamp));
          manager.appendMessage(assistant([{ type: "text", text: "Checking." }]));
          manager.appendMessage(makeUserMessage("[OpenClaw heartbeat poll]", timestamp));
          manager.appendMessage(
            assistant(
              ["missing", "real", "error", "quoted"].map((id) => ({
                type: "toolCall",
                id: `call${id}`,
                name: "read",
                arguments: { path: `${id}.txt` },
              })),
              "toolUse",
            ),
          );
          const missing = makeMissingToolResult({ toolCallId: "callmissing", toolName: "read" });
          if (legacy) {
            delete missing.details;
          }
          manager.appendMessage(missing);
          if (late) {
            manager.appendMessage({
              ...missing,
              details: undefined,
              isError: false,
              content: [{ type: "text", text: "LATE_ACTUAL_RESULT" }],
            });
          }
          for (const result of [
            { id: "real", text: "REAL_SIBLING_RESULT", isError: false },
            { id: "error", text: "File not found", isError: true },
            { id: "quoted", text: DEFAULT_MISSING_TOOL_RESULT_TEXT, isError: false },
          ]) {
            manager.appendMessage({
              role: "toolResult",
              toolCallId: `call${result.id}`,
              toolName: "read",
              timestamp,
              isError: result.isError,
              content: [{ type: "text", text: result.text }],
            });
          }
          manager.appendMessage(assistant([{ type: "text", text: "USEFUL_ALERT" }]));
          manager.appendMessage(makeUserMessage("[OpenClaw heartbeat poll]", timestamp));
          manager.appendMessage(assistant([{ type: "text", text: "HEARTBEAT_OK" }]));
          manager.flushPendingPersistence();
          const original = readStoredRows(target.storePath, sessionId);
          const requestCount = requests.length;
          const started = await client.request<{ runId: string; status: string }>("chat.send", {
            sessionKey,
            message: "Summarize the health check.",
            idempotencyKey: randomUUID(),
            deliver: false,
          });
          expect(started.status).toBe("started");
          await expect(
            client.request("agent.wait", { runId: started.runId, timeoutMs: 30000 }),
          ).resolves.toMatchObject({ status: "ok" });
          expect(requests).toHaveLength(requestCount + 1);
          const request = requests[requestCount];
          assert(request, "chat.send must reach the HTTP receiver");
          expect(request.model).toBe(model);
          const blocks = request.messages.flatMap((message) =>
            typeof message.content === "string"
              ? [{ type: "text" as const, text: message.content }]
              : message.content,
          );
          const results = blocks.filter((block) => block.type === "tool_result");
          expect(results).toHaveLength(4);
          expect.soft(results, scenario).toEqual([
            expect.objectContaining({
              tool_use_id: "callmissing",
              content: late ? "LATE_ACTUAL_RESULT" : "No result provided",
              is_error: !late,
            }),
            expect.objectContaining({
              tool_use_id: "callreal",
              content: "REAL_SIBLING_RESULT",
              is_error: false,
            }),
            expect.objectContaining({
              tool_use_id: "callerror",
              content: "File not found",
              is_error: true,
            }),
            expect.objectContaining({
              tool_use_id: "callquoted",
              content: DEFAULT_MISSING_TOOL_RESULT_TEXT,
              is_error: false,
            }),
          ]);
          expect(blocks.filter((block) => block.type === "tool_use")).toEqual(
            ["missing", "real", "error", "quoted"].map((id) =>
              expect.objectContaining({
                id: `call${id}`,
                name: "read",
                input: { path: `${id}.txt` },
              }),
            ),
          );
          expect(blocks).toContainEqual(
            expect.objectContaining({ type: "text", text: "USEFUL_ALERT" }),
          );
          expect(JSON.stringify(request.messages)).not.toContain("HEARTBEAT_OK");
          const after = readStoredRows(target.storePath, sessionId);
          expect(after.slice(0, original.length)).toEqual(original);
          expect(after.length).toBeGreaterThan(original.length);
          expect(after.at(-1)?.event_json).toContain("REPLAY_SETTLED");
        }
      }
    } finally {
      try {
        await disconnectGatewayClient(client);
      } finally {
        await server.close({ reason: "Synthetic repair replay complete" });
      }
    }
  } finally {
    endpoint.closeAllConnections();
    try {
      if (endpoint.listening) {
        await new Promise<void>((resolve, reject) => {
          endpoint.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await Promise.all(providerWork);
    } finally {
      await state.cleanup();
    }
  }
}, 90000);

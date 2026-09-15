import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import * as subscriptions from "./server-runtime-subscriptions.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it("binds a first native chat.send before streaming and persists its stopped partial", async () => {
  const state = await createNativeChatTestState("first-turn-binding");
  const runId = "first-native-turn";
  const sessionKey = "agent:main:first-turn-binding";
  const partial = "This is the first native assistant partial.";
  const providerResponse = createDeferred<ServerResponse>();
  const providerClosed = createDeferred();
  const firstDelta = createDeferred();
  const terminal = createDeferred();
  const requestBodies: string[] = [];
  // Call-through observation exposes the real Gateway-owned buffer and registration.
  const observeSubscriptions = vi.spyOn(subscriptions, "startGatewayEventSubscriptions");
  const providerServer = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      requestBodies.push(Buffer.concat(chunks).toString("utf8"));
      response.once("close", () => providerClosed.resolve());
      providerResponse.resolve(response);
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  let original: ChatAbortControllerEntry | undefined;
  const lifecycle: Array<{ phase?: unknown; sessionId?: unknown; aborted?: unknown }> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      providerServer.once("error", reject);
      providerServer.listen(0, "127.0.0.1", resolve);
    });
    const address = providerServer.address();
    if (!address || typeof address === "string") {
      throw new Error("mock provider did not bind");
    }
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "first-turn",
    );
    const cfg = createNativeChatConfig(state.workspaceDir, provider, "first-turn-test");
    gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token: "first-turn-test",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent: (event) => {
        const payload = event.payload as
          | {
              runId?: string;
              state?: string;
              stream?: string;
              sessionId?: string;
              data?: { phase?: string; aborted?: boolean };
            }
          | undefined;
        if (payload?.runId !== runId) {
          return;
        }
        if (event.event === "chat" && payload.state === "delta") {
          firstDelta.resolve();
        }
        if (event.event === "chat" && payload.state === "aborted") {
          terminal.resolve();
        }
        if (event.event === "agent" && payload.stream === "lifecycle") {
          lifecycle.push({ ...payload.data, sessionId: payload.sessionId });
        }
      },
    });
    const runtime = observeSubscriptions.mock.calls.at(-1)?.[0];
    expect(runtime).toBeDefined();
    if (!runtime) {
      throw new Error("Gateway subscriptions were not started");
    }
    expect(loadExactSessionEntryReadOnly({ sessionKey })?.entry).toBeUndefined();
    await gateway.client.request("sessions.messages.subscribe", { key: sessionKey });
    expect(
      await gateway.client.request("chat.send", {
        sessionKey,
        message: "Start a reply and wait for Stop.",
        idempotencyKey: runId,
      }),
    ).toMatchObject({ runId, status: "started" });
    const response = await providerResponse.promise;
    original = runtime.chatAbortControllers.get(runId);
    expect(original).toBeDefined();
    const committed = loadExactSessionEntryReadOnly({ sessionKey });
    expect(committed?.entry.sessionId).toBeDefined();
    if (!original || !committed) {
      throw new Error("Native initialization did not retain its registration and session");
    }
    expect(committed.entry.sessionId).not.toBe(runId);
    expect.soft(original.sessionId).toBe(committed.entry.sessionId);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "first-message",
          role: "assistant",
          content: [],
          status: "in_progress",
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "first-message",
        output_index: 0,
        content_index: 0,
        delta: partial,
      },
    ]) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    await firstDelta.promise;
    expect(runtime.chatRunState.resolveBuffer(runId).text).toBe(partial);
    expect.soft(original.sessionId).toBe(committed.entry.sessionId);
    expect(lifecycle).toContainEqual(
      expect.objectContaining({ phase: "start", sessionId: committed.entry.sessionId }),
    );
    const stop = await gateway.client
      .request("chat.send", {
        sessionKey,
        message: "/stop",
        idempotencyKey: "stop-first-native-turn",
      })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    expect.soft(stop).toMatchObject({ result: { ok: true, aborted: true, runIds: [runId] } });
    expect(original.controller.signal.aborted).toBe(true);
    await terminal.promise;
    await providerClosed.promise;
    await vi.waitFor(() => expect(runtime.chatAbortControllers.has(runId)).toBe(false));
    expect
      .soft(loadExactSessionEntryReadOnly({ sessionKey })?.entry, JSON.stringify(lifecycle))
      .toMatchObject({
        sessionId: committed.entry.sessionId,
        status: "killed",
        abortedLastRun: true,
      });
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        phase: "end",
        status: "cancelled",
        aborted: true,
        stopReason: "stop",
        sessionId: committed.entry.sessionId,
      }),
    );
    const events = await loadTranscriptEvents({
      sessionKey,
      sessionId: committed.entry.sessionId,
      agentId: "main",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: partial }],
          openclawAbort: { aborted: true, origin: "stop-command", runId },
        }),
      }),
    );
    expect(requestBodies).toHaveLength(1);
  } finally {
    original?.controller.abort();
    providerServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      providerServer.close(() => resolve());
    });
    try {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "first-turn binding test cleanup" });
      }
    } finally {
      observeSubscriptions.mockRestore();
      await state.cleanup();
    }
  }
});

const STREAM_DELTAS = [
  "Visible\n<tool_call>exec ",
  "<arg_key>\ncommand\n",
  "</arg_key><arg_value>echo redacted</arg_value></tool_call>",
  "\nDone.",
] as const;
const TERMINAL_TEXT = STREAM_DELTAS.join("");
const DELIVERED_TEXT = "Visible\n\nDone.";
const RUN_ID = "glm-arg-key-delivery";
const SESSION_KEY = "agent:main:glm-arg-key-delivery";
const TOKEN = "glm-arg-key-delivery-token";

function writeSse(response: import("node:http").ServerResponse, event: unknown) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function chatMessageText(payload: unknown): string {
  const message = (payload as { message?: unknown } | undefined)?.message;
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("");
}

it(
  "strips streamed GLM <tool_call>exec <arg_key> shadow XML from chat.final",
  { timeout: 90_000 },
  async () => {
    const state = await createNativeChatTestState("glm-arg-key-delivery");
    const terminal = createDeferred<unknown>();
    const providerServer = createServer((request, response) => {
      void (async () => {
        for await (const chunk of request) {
          void chunk;
        }
        const message = {
          type: "message",
          id: "glm-msg",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: TERMINAL_TEXT, annotations: [] }],
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        writeSse(response, {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        });
        for (const delta of STREAM_DELTAS) {
          writeSse(response, {
            type: "response.output_text.delta",
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta,
          });
          await delay(15);
        }
        writeSse(response, {
          type: "response.output_text.done",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          text: TERMINAL_TEXT,
        });
        writeSse(response, { type: "response.output_item.done", output_index: 0, item: message });
        writeSse(response, {
          type: "response.completed",
          response: {
            id: "glm-response",
            status: "completed",
            output: [message],
            usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 },
          },
        });
        response.end("data: [DONE]\n\n");
      })().catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("mock provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "glm-proof",
      );
      const cfg = createNativeChatConfig(state.workspaceDir, provider, TOKEN);
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: TOKEN,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => {
          const payload = event.payload as { runId?: string; state?: string } | undefined;
          if (event.event === "chat" && payload?.runId === RUN_ID && payload.state === "final") {
            terminal.resolve(event.payload);
          }
        },
      });
      await gateway.client.request("sessions.messages.subscribe", { key: SESSION_KEY });
      await gateway.client.request("chat.send", {
        sessionKey: SESSION_KEY,
        message: "Reply with the scripted GLM shadow text.",
        idempotencyKey: RUN_ID,
      });
      const delivered = chatMessageText(await terminal.promise);
      expect(delivered).toBe(DELIVERED_TEXT);
      expect(delivered).not.toMatch(/<arg_key\b|<tool_call>exec/i);
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        await gateway.server.close({ reason: "glm arg_key delivery proof cleanup" });
      }
      await new Promise<void>((resolve) => {
        providerServer.close(() => resolve());
      });
      await state.cleanup();
    }
  },
);

function createNativeChatTestState(label: string) {
  return createOpenClawTestState({
    label,
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    },
  });
}

function createNativeChatConfig(
  workspace: string,
  provider: ReturnType<typeof buildMockOpenAiResponsesProvider>,
  token: string,
) {
  return {
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        heartbeat: { every: "0m" },
        model: { primary: provider.modelRef },
        models: {
          [provider.modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
      },
    },
    models: {
      mode: "replace",
      providers: {
        [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
      },
    },
    plugins: { slots: { memory: "none" } },
    tools: { profile: "minimal" },
    gateway: { auth: { mode: "token", token } },
  } satisfies OpenClawConfig;
}

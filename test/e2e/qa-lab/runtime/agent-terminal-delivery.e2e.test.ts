import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { resolveSessionStorePathCore } from "../../../../src/config/sessions/paths.js";
import { loadTranscriptEventsSync } from "../../../../src/config/sessions/session-accessor.js";
import { captureEnv, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const MODEL = "mock-openai/terminal-primary";
const PREFIX = "NO_REPLY";
const MISSING_REPLY_NOTICE = "No answer was returned. Ask again if you still need one.";

type Event = {
  event: string;
  payload?: {
    runId?: string;
    state?: string;
    stream?: string;
    deltaText?: string;
    data?: { text?: string; delta?: string; phase?: string };
  };
};
type Delivery = { to: string; text: string };

function writeEvent(response: ServerResponse, event: unknown) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function createScript(id: string) {
  const opened = createDeferred<ServerResponse>();
  const message = {
    id: `message-${id}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "", annotations: [] }],
  };
  const reasoning = { id: `reasoning-${id}`, type: "reasoning", summary: [] };
  let text = "";
  let progress = "";
  let response: ServerResponse;
  return {
    opened: opened.promise,
    open(next: ServerResponse) {
      response = next;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.flushHeaders();
      writeEvent(response, {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      });
      writeEvent(response, {
        type: "response.output_item.added",
        output_index: 1,
        item: reasoning,
      });
      writeEvent(response, {
        type: "response.reasoning_summary_part.added",
        item_id: reasoning.id,
        output_index: 1,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
      opened.resolve(response);
    },
    append(delta: string, barrier: string) {
      text += delta;
      writeEvent(response, {
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta,
      });
      // A subsequent thinking event flushes the assistant stream in provider order.
      // Observing it proves the prefix was consumed, not merely written to a socket.
      progress += barrier;
      writeEvent(response, {
        type: "response.reasoning_summary_text.delta",
        item_id: reasoning.id,
        output_index: 1,
        summary_index: 0,
        delta: barrier,
      });
    },
    finish(incomplete = false) {
      const completed = { ...message, content: [{ type: "output_text", text, annotations: [] }] };
      writeEvent(response, {
        type: "response.output_text.done",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        text,
      });
      writeEvent(response, { type: "response.output_item.done", output_index: 0, item: completed });
      writeEvent(response, {
        type: "response.output_item.done",
        output_index: 1,
        item: { ...reasoning, summary: [{ type: "summary_text", text: progress }] },
      });
      writeEvent(response, {
        type: incomplete ? "response.incomplete" : "response.completed",
        response: {
          id: `response-${id}`,
          status: incomplete ? "incomplete" : "completed",
          ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
          output: [
            completed,
            { ...reasoning, summary: [{ type: "summary_text", text: progress }] },
          ],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      });
      response.end("data: [DONE]\n\n");
    },
  };
}

function assistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const row = message as { role?: string; content?: unknown };
  if (row.role !== "assistant") {
    return undefined;
  }
  if (typeof row.content === "string") {
    return row.content;
  }
  if (!Array.isArray(row.content)) {
    return undefined;
  }
  const text = row.content
    .flatMap((part: unknown) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      const block = part as { type?: string; text?: string };
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("");
  return text || undefined;
}

describe("provider terminal reply delivery", () => {
  it(
    "holds every strict NO_REPLY prefix and shares the prepared final with channel and SQLite history",
    {
      timeout: 180_000,
    },
    async ({ signal }) => {
      const events: Event[] = [];
      const deliveries: Delivery[] = [];
      const eventWaiters = new Set<() => void>();
      const waitForEvent = (predicate: (event: Event) => boolean) => {
        const ready = createDeferred();
        const inspect = () => {
          if (events.some(predicate)) {
            eventWaiters.delete(inspect);
            ready.resolve();
          }
        };
        eventWaiters.add(inspect);
        inspect();
        return withinTest(ready.promise, signal).finally(() => eventWaiters.delete(inspect));
      };
      const cases = [
        { id: "silent", raw: "NO_REPLY", expected: undefined },
        {
          id: "suffix",
          raw: "NO_REPLY\nNO_REPLY\nI started the watcher.",
          expected: "NO_REPLY\nI started the watcher.",
        },
        { id: "punctuation", raw: "NO_REPLY.", expected: "NO_REPLY." },
        { id: "json", raw: '{"action":"NO_REPLY"}', expected: '{"action":"NO_REPLY"}' },
        {
          id: "prose",
          raw: "I started the watcher. NO_REPLY",
          expected: "I started the watcher. NO_REPLY",
        },
        { id: "trimmed", raw: " \tNO_REPLY\n", expected: undefined },
        { id: "lowercase", raw: "no_reply", expected: "no_reply" },
        { id: "quoted", raw: '"NO_REPLY"', expected: '"NO_REPLY"' },
        { id: "literal", raw: "NO_REPLY\nNO_REPLY", expected: "NO_REPLY" },
        { id: "crlf", raw: "NO_REPLY\r\nAnswer", expected: "NO_REPLY\r\nAnswer" },
        { id: "indented", raw: " NO_REPLY\nAnswer", expected: " NO_REPLY\nAnswer" },
      ];
      const scripts = cases.map(({ id }) => createScript(id));
      let emptyFinals = false;
      const emptyNoticeDelivered = createDeferred();
      const requests: unknown[] = [];
      const transportErrors: Error[] = [];
      const server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body: unknown = chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
            : {};
          if (request.url === "/v1/responses") {
            const index = requests.length;
            requests.push(body);
            if (emptyFinals) {
              expect(deliveries.filter((delivery) => delivery.to === "dm:terminal-empty")).toEqual(
                [],
              );
              const empty = createScript(`empty-${index}`);
              empty.open(response);
              // A provider-declared output limit permits fallback; the final model exhausts empty.
              empty.finish(asOptionalObjectRecord(body)?.model === "terminal-primary");
              return;
            }
            const script = scripts[index];
            if (!script) {
              throw new Error("Unscripted provider turn");
            }
            script.open(response);
            return;
          }
          response.setHeader("content-type", "application/json");
          if (request.url === "/v1/outbound/message") {
            const delivery = body as Delivery;
            deliveries.push(delivery);
            if (delivery.to === "dm:terminal-empty") {
              emptyNoticeDelivered.resolve();
            }
            response.end(
              JSON.stringify({ message: { ...delivery, id: `outbound-${deliveries.length}` } }),
            );
            return;
          }
          if (request.method === "POST" && request.url === "/v1/poll") {
            await delay(250, undefined, { ref: false });
            if (!response.destroyed) {
              response.end(JSON.stringify({ cursor: 0, events: [] }));
            }
            return;
          }
          if (request.method === "GET" && request.url === "/v1/models") {
            response.end(
              JSON.stringify({
                data: ["terminal-primary", "terminal-fallback"].map((id) => ({
                  id,
                  object: "model",
                })),
              }),
            );
            return;
          }
          throw new Error(`Unexpected transport request: ${request.method} ${request.url}`);
        })().catch((error: unknown) => {
          transportErrors.push(error instanceof Error ? error : new Error(String(error)));
          response.writeHead(500).end("Unexpected fixture request");
        });
      });
      const owner = createQaGatewayChild();
      let client: GatewayClient | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Provider did not bind a loopback port");
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const gateway = await owner.start({
          repoRoot: process.cwd(),
          useRepoCli: false,
          providerBaseUrl: `${baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL,
          alternateModel: "mock-openai/terminal-fallback",
          transportBaseUrl: baseUrl,
          transport: createQaChannelTransport(createQaBusState()),
          controlUiEnabled: false,
          fastMode: true,
          runtimeEnvPatch: { OPENCLAW_TEST_MINIMAL_GATEWAY: "1" },
          mutateConfig: (config) => ({
            ...config,
            skills: { load: { watch: false } },
            memory: { search: { enabled: false } },
          }),
        });
        const connected = createDeferred();
        client = new GatewayClient({
          url: gateway.wsUrl,
          token: gateway.token,
          env: gateway.runtimeEnv,
          role: "operator",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          clientDisplayName: "Terminal reply boundary proof",
          clientVersion: "1.0.0",
          platform: process.platform,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
          scopes: ["operator.admin", "operator.read", "operator.write"],
          deviceIdentity: null,
          requestTimeoutMs: 30_000,
          onEvent: (event) => {
            events.push(event as Event);
            for (const inspect of eventWaiters) {
              inspect();
            }
          },
          onHelloOk: () => connected.resolve(),
          onConnectError: (error) => connected.reject(error),
        });
        client.start();
        await withinTest(connected.promise, signal);
        const sessionKeys = cases.map(({ id }) => `agent:qa:qa:terminal-${id}`);
        const deliveredTexts = (target: string) =>
          deliveries.filter((delivery) => delivery.to === target).map((delivery) => delivery.text);
        for (const [index, testCase] of cases.entries()) {
          const runId = `terminal-${testCase.id}`;
          const sessionKey = sessionKeys[index]!;
          const target = `dm:terminal-${testCase.id}`;
          const script = scripts[index]!;
          const expected = testCase.expected ? [testCase.expected] : [];
          await client.request("sessions.messages.subscribe", { key: sessionKey });
          const accepted = await client.request("agent", {
            sessionKey,
            message: `Return the scripted ${testCase.id} result.`,
            channel: "qa-channel",
            replyChannel: "qa-channel",
            replyTo: target,
            deliver: true,
            idempotencyKey: runId,
          });
          expect(accepted).toMatchObject({ status: "accepted", runId });
          await withinTest(script.opened, signal);
          let progress = "";
          const appendAndObserve = async (delta: string, marker: string) => {
            progress += marker;
            script.append(delta, marker);
            await waitForEvent(
              (event) =>
                event.event === "agent" &&
                event.payload?.runId === runId &&
                event.payload.stream === "thinking" &&
                event.payload.data?.text === progress,
            );
          };
          const streamed = () =>
            events
              .flatMap((event) =>
                event.event === "agent" &&
                event.payload?.runId === runId &&
                event.payload.stream === "assistant"
                  ? [event.payload.data?.delta ?? ""]
                  : [],
              )
              .join("");
          if (index < 3) {
            for (let length = 1; length < PREFIX.length; length++) {
              await appendAndObserve(PREFIX[length - 1]!, `[prefix-${length}]`);
              expect(streamed(), `strict prefix length ${length}`).toBe("");
              expect(deliveredTexts(target)).toEqual([]);
              expect(
                events
                  .filter(
                    (event) =>
                      event.event === "chat" &&
                      event.payload?.runId === runId &&
                      event.payload.state === "delta",
                  )
                  .map((event) => event.payload?.deltaText ?? "")
                  .join(""),
              ).toBe("");
            }
            await appendAndObserve("Y", "[token]");
            expect(streamed()).toBe("");
            if (testCase.raw.length > PREFIX.length) {
              await appendAndObserve(testCase.raw.slice(PREFIX.length), "[suffix]");
              expect(streamed()).toBe(testCase.expected);
            }
          } else {
            await appendAndObserve(testCase.raw, "[report]");
          }
          script.finish();
          const terminal = await client.request(
            "agent.wait",
            { runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          );
          expect(terminal).toMatchObject({ runId, status: "ok" });
          await waitForEvent(
            (event) =>
              event.event === "chat" &&
              event.payload?.runId === runId &&
              event.payload.state === "final",
          );
          expect(deliveredTexts(target)).toEqual(expected.map((text) => text.trim()));
          const history = await client.request<{ sessionId: string; messages: unknown[] }>(
            "chat.history",
            { sessionKey, limit: 20, maxChars: 50_000 },
          );
          expect(history.messages.map(assistantText).filter((text) => text !== undefined)).toEqual(
            expected,
          );
        }
        expect(requests).toHaveLength(cases.length);
        const firstEmptyRequest = requests.length;
        const emptyRunId = "terminal-empty";
        const emptySessionKey = "agent:qa:qa:terminal-empty";
        emptyFinals = true;
        await client.request("agent", {
          sessionKey: emptySessionKey,
          message: "Return the scripted empty result.",
          channel: "qa-channel",
          replyChannel: "qa-channel",
          replyTo: "dm:terminal-empty",
          deliver: true,
          idempotencyKey: emptyRunId,
        });
        expect(
          await client.request(
            "agent.wait",
            { runId: emptyRunId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        ).toMatchObject({ status: "error" });
        await withinTest(emptyNoticeDelivered.promise, signal);
        expect(deliveredTexts("dm:terminal-empty")).toEqual([MISSING_REPLY_NOTICE]);
        expect([
          ...new Set(
            requests
              .slice(firstEmptyRequest)
              .map((request) => asOptionalObjectRecord(request)?.model),
          ),
        ]).toEqual(["terminal-primary", "terminal-fallback"]);
        const emptyHistory = await client.request<{ sessionId: string; messages: unknown[] }>(
          "chat.history",
          {
            sessionKey: emptySessionKey,
            limit: 20,
          },
        );
        expect(
          emptyHistory.messages.filter((message) => {
            const row = asOptionalObjectRecord(message);
            return (
              row?.role === "assistant" &&
              asOptionalObjectRecord(row.openclawDeliveryMirror)?.kind !== "model-fallback"
            );
          }),
        ).toEqual([]);

        await client.stopAndWait();
        client = undefined;
        await gateway.restartAfterStateMutation(async ({ runtimeEnv }) => {
          // The Gateway is stopped: the parent now has exclusive custody of its SQLite stores.
          const envKeys = ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"];
          const env = captureEnv(envKeys);
          try {
            for (const key of envKeys) {
              const value = runtimeEnv[key];
              if (value !== undefined) {
                setTestEnvValue(key, value);
              }
            }
            clearRuntimeConfigSnapshot();
            clearConfigCache();
            const storePath = resolveSessionStorePathCore(gateway.cfg.session?.store, {
              agentId: "qa",
              env: runtimeEnv,
            });
            const emptyRows = loadTranscriptEventsSync({
              agentId: "qa",
              storePath,
              sessionKey: emptySessionKey,
              sessionId: emptyHistory.sessionId,
            });
            expect(
              emptyRows.filter((row) => {
                const message = asOptionalObjectRecord(asOptionalObjectRecord(row)?.message);
                return (
                  assistantText(message)?.trim() &&
                  asOptionalObjectRecord(message?.openclawDeliveryMirror)?.kind !== "model-fallback"
                );
              }),
            ).toEqual([]);
          } finally {
            clearRuntimeConfigSnapshot();
            clearConfigCache();
            env.restore();
          }
        });
        // A fresh Gateway process cannot satisfy history from the first process's caches.
        for (const [index, testCase] of cases.entries()) {
          const history = (await gateway.call("chat.history", {
            sessionKey: sessionKeys[index],
            limit: 20,
            maxChars: 50_000,
          })) as { messages: unknown[] };
          expect(history.messages.map(assistantText).filter((text) => text !== undefined)).toEqual(
            testCase.expected ? [testCase.expected] : [],
          );
        }
        expect(transportErrors).toEqual([]);
      } finally {
        try {
          await client?.stopAndWait();
        } finally {
          try {
            await stopQaGatewayFixture(owner);
          } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
        }
      }
    },
  );
});

import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type ProviderMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  reasoning_details?: unknown;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
};
type ProviderRequest = { model: string; messages: ProviderMessage[] };
type HistoryMessage = { role: string; content: unknown; stopReason?: string };

it(
  "chat.send retains only matching encrypted tool state across real reads and reasoning visibility",
  { timeout: 90_000 },
  async () => {
    let arrival = "before";
    const root = tempDirs.make("openclaw-encrypted-continuation-");
    const workspace = path.join(root, "workspace");
    const state = path.join(root, "state");
    const plugins = path.join(root, "plugins");
    await Promise.all([workspace, state, plugins].map((directory) => fs.mkdir(directory)));
    const fixture = path.join(workspace, "fixture.txt");
    const marker = "ENCRYPTED_CONTINUATION_READ_RESULT";
    const answer = "ENCRYPTED_CONTINUATION_ACCEPTED";
    const rejectedAnswer = "The incomplete read was rejected; no file was read.";
    await fs.writeFile(fixture, marker);
    const configPath = path.join(state, "openclaw.json");
    const env = {
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: "encrypted-continuation-fixture",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: plugins,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const snapshot = captureEnv(Object.keys(env));
    for (const [key, value] of Object.entries(env)) {
      setTestEnvValue(key, value);
    }
    const detail = {
      type: "reasoning.encrypted",
      id: "callsigned",
      data: "synthetic-opaque-continuation",
    };
    const secondDetail = { ...detail, id: "callsecond", data: "synthetic-second-continuation" };
    const visibleReasoning = "Compare the fixture results.";
    let details = [detail];
    let callIds = ["callsigned", "callunsigned"];
    const partialResponse = createDeferred();
    const abortedResponse = createDeferred();
    const requests: ProviderRequest[] = [];
    const events: unknown[] = [];
    const provider = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body: ProviderRequest = JSON.parse(raw);
        requests.push(body);
        const toolResults = body.messages.filter((message) => message.role === "tool");
        const continuation = toolResults.length > 0;
        const assistant = body.messages.findLast((message) => message.tool_calls?.length);
        if (
          continuation &&
          !arrival.startsWith("renamed-") &&
          !isDeepStrictEqual(assistant?.reasoning_details, details)
        ) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "Synthetic contract rejection: missing encrypted detail",
                type: "invalid_request_error",
              },
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = (delta: unknown, finishReason: string | null = null) => {
          response.write(
            `data: ${JSON.stringify({
              id: `completion_${requests.length}`,
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            })}\n\n`,
          );
        };
        if (["malformed", "missing-terminal", "abort"].includes(arrival)) {
          if (arrival !== "abort" && requests.length > 1) {
            send({ content: rejectedAnswer });
            send({}, "stop");
            response.end("data: [DONE]\n\n");
            return;
          }
          send({ reasoning_details: details });
          send({
            tool_calls: [
              {
                index: 0,
                id: "callsigned",
                type: "function",
                function: {
                  name: "read",
                  arguments:
                    arrival === "missing-terminal" ? JSON.stringify({ path: fixture }) : '{"path":',
                },
              },
            ],
          });
          if (arrival === "abort") {
            response.once("close", () => abortedResponse.resolve());
            partialResponse.resolve();
            return;
          }
          if (arrival === "malformed") {
            send({}, "tool_calls");
            response.end("data: [DONE]\n\n");
          } else {
            response.end();
          }
          return;
        }
        if (continuation) {
          send({ content: answer });
          send({}, "stop");
        } else if (arrival.startsWith("renamed-")) {
          const oldDetail = { ...detail, id: "callA", data: "synthetic-old-identity" };
          if (arrival === "renamed-unsigned") {
            send({ reasoning_details: [oldDetail] });
          }
          send({
            tool_calls: [
              {
                index: 0,
                id: "callA",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: fixture }) },
              },
            ],
          });
          send({ tool_calls: [{ index: 0, id: "callB" }] });
          if (arrival === "renamed-signed") {
            send({ reasoning_details: details });
            send({ reasoning_details: [oldDetail] });
          }
          send({}, "tool_calls");
        } else {
          send({ reasoning: visibleReasoning });
          const reasoning = {
            reasoning_details: [
              null,
              { type: "reasoning.encrypted", id: "callunsigned", data: "" },
              { type: "reasoning.encrypted", id: "callunsigned", data: 7 },
              { type: "reasoning.encrypted", id: "", data: "synthetic-empty-id" },
              { type: "reasoning.encrypted", id: "orphan", data: "synthetic-unmatched" },
              ...details,
            ],
          };
          const calls = {
            tool_calls: callIds.map((id, index) => ({
              index,
              id,
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: fixture }) },
            })),
          };
          if (arrival !== "same" && arrival !== "after") {
            send(reasoning);
          }
          send(arrival === "same" ? { ...reasoning, ...calls } : calls);
          if (arrival === "after") {
            send(reasoning);
          }
          send({}, "tool_calls");
        }
        response.end("data: [DONE]\n\n");
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve) => {
        provider.listen(0, "127.0.0.1", resolve);
      });
      const address = provider.address();
      if (!address || typeof address === "string") {
        throw new Error("synthetic provider did not bind");
      }
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              model: { primary: "openrouter/google/gemini-encrypted-fixture" },
              thinkingDefault: "off",
            },
            entries: { main: { default: true } },
          },
          models: {
            mode: "replace",
            providers: {
              openrouter: {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "synthetic-fixture-key",
                api: "openai-completions",
                models: [
                  {
                    id: "google/gemini-encrypted-fixture",
                    name: "Encrypted fixture",
                    api: "openai-completions",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
          plugins: { slots: { memory: "none" } },
          logging: { file: path.join(root, "gateway.log") },
          gateway: { auth: { mode: "token", token: env.OPENCLAW_GATEWAY_TOKEN } },
        },
        configPath,
        token: env.OPENCLAW_GATEWAY_TOKEN,
        onEvent: (event) => events.push(event),
      });
      for (const order of [
        "before",
        "same",
        "after",
        "multiple",
        "visible",
        "renamed-unsigned",
        "renamed-signed",
        "malformed",
        "missing-terminal",
        "abort",
      ]) {
        arrival = order;
        if (order.startsWith("renamed-")) {
          details = order === "renamed-signed" ? [{ ...detail, id: "callB" }] : [];
          callIds = ["callB"];
        } else {
          details = order === "multiple" ? [detail, secondDetail] : [detail];
          callIds =
            order === "multiple"
              ? ["callsigned", "callunsigned", "callsecond"]
              : ["callsigned", "callunsigned"];
        }
        requests.length = 0;
        events.length = 0;
        const sessionKey = `agent:main:encrypted-${arrival}`;
        const started = await gateway.client.request<{ runId: string; status: string }>(
          "chat.send",
          {
            sessionKey,
            message: "Read fixture.txt twice and report the result.",
            deliver: false,
            idempotencyKey: `encrypted-${arrival}`,
            thinking: order === "visible" ? "low" : "off",
          },
        );
        expect(started.status).toBe("started");
        if (order === "abort") {
          await partialResponse.promise;
          expect(
            await gateway.client.request("chat.abort", { sessionKey, runId: started.runId }),
          ).toMatchObject({ aborted: true });
          await abortedResponse.promise;
        }
        const waited = await gateway.client.request<{ status: string; stopReason?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        const history = await gateway.client.request<{ messages: HistoryMessage[] }>(
          "chat.history",
          {
            sessionKey,
            limit: 30,
          },
        );
        if (["malformed", "missing-terminal", "abort"].includes(order)) {
          expect(requests.length).toBeGreaterThan(0);
          expect(
            requests.flatMap(({ messages }) => messages.filter(({ role }) => role === "tool")),
          ).toEqual([]);
          expect(history.messages.filter(({ role }) => role === "toolResult")).toEqual([]);
          expect(JSON.stringify(history.messages)).not.toContain('"type":"toolCall"');
          expect(JSON.stringify(history.messages)).not.toContain(answer);
          expect(waited.status, JSON.stringify({ order, waited, requests: requests.length })).toBe(
            order === "abort" ? "error" : "ok",
          );
          expect(
            requests.flatMap(({ messages }) =>
              messages.filter(({ reasoning_details }) => reasoning_details !== undefined),
            ),
          ).toEqual([]);
          if (order !== "abort") {
            expect(requests).toHaveLength(2);
            expect(
              JSON.stringify(
                history.messages.findLast(({ role }) => role === "assistant")?.content,
              ),
            ).toContain(rejectedAnswer);
          } else {
            expect(waited.stopReason).toBe("rpc");
            expect(requests).toHaveLength(1);
          }
          continue;
        }
        const continuation = requests.find((request) =>
          request.messages.some((message) => message.role === "tool"),
        );
        expect(continuation?.messages.filter((message) => message.role === "tool")).toEqual(
          callIds.map((id) =>
            expect.objectContaining({
              tool_call_id: id,
              content: expect.stringContaining(marker),
            }),
          ),
        );
        const associationExpect = order.startsWith("renamed-") ? expect.soft : expect;
        associationExpect(
          continuation?.messages.findLast((message) => message.tool_calls?.length)
            ?.reasoning_details,
          `${order}: actual continuation encrypted details`,
        ).toEqual(details.length > 0 ? details : undefined);
        associationExpect(
          history.messages.find(
            (message) => message.role === "assistant" && message.stopReason === "toolUse",
          )?.content,
          `${order}: persisted tool identity and encrypted state`,
        ).toEqual([
          ...(order === "visible"
            ? [expect.objectContaining({ type: "thinking", thinking: visibleReasoning })]
            : []),
          ...callIds.map((id) => {
            const expectedDetail = details.find((candidate) => candidate.id === id);
            return {
              type: "toolCall",
              id,
              name: "read",
              arguments: { path: fixture },
              ...(expectedDetail
                ? {
                    thoughtSignature: JSON.stringify({
                      type: expectedDetail.type,
                      data: expectedDetail.data,
                      id: expectedDetail.id,
                    }),
                  }
                : {}),
            };
          }),
        ]);
        expect(
          JSON.stringify(
            history.messages.findLast((message) => message.role === "assistant")?.content,
          ),
        ).not.toContain(detail.data);
        expect(waited.status).toBe("ok");
        expect(requests).toHaveLength(2);
        expect(history.messages.filter((message) => message.role === "toolResult")).toHaveLength(
          callIds.length,
        );
        expect(
          JSON.stringify(
            history.messages.findLast((message) => message.role === "assistant")?.content,
          ),
        ).toContain(answer);
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "chat",
            payload: expect.objectContaining({ runId: started.runId, state: "final" }),
          }),
        );
      }
    } finally {
      provider.closeAllConnections();
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close();
      }
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()));
      });
      snapshot.restore();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();
    }
  },
);

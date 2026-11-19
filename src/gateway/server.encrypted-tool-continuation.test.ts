import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { createTrackedProvider } from "./test-helpers.tracked-provider.js";

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
    const home = await setupGatewayTempHome({ prefix: "openclaw-encrypted-continuation-" });
    onTestFinished(async () => {
      resetGatewayTestState();
      try {
        await removeGatewayTempHome(home.tempHome);
      } finally {
        home.envSnapshot.restore();
      }
    });
    const workspace = home.workspaceDir;
    const token = "encrypted-continuation-fixture";
    const fixture = path.join(workspace, "fixture.txt");
    const marker = "ENCRYPTED_CONTINUATION_READ_RESULT";
    const answer = "ENCRYPTED_CONTINUATION_ACCEPTED";
    const rejectedAnswer = "The incomplete read was rejected; no file was read.";
    await fs.writeFile(fixture, marker);
    const configPath = await createGatewayConfigPath(home.tempHome);
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
    const incomplete = () => ["malformed", "missing-terminal", "abort"].includes(arrival);
    const toolCall = (id: string, index = 0, args = JSON.stringify({ path: fixture })) => ({
      index,
      id,
      type: "function",
      function: { name: "read", arguments: args },
    });
    const provider = createTrackedProvider((raw, response) => {
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
      if (incomplete()) {
        if (arrival !== "abort" && requests.length > 1) {
          send({ content: rejectedAnswer });
          send({}, "stop");
          response.end("data: [DONE]\n\n");
          return;
        }
        send({ reasoning_details: details });
        send({
          tool_calls: [
            toolCall(
              "callsigned",
              0,
              arrival === "missing-terminal" ? JSON.stringify({ path: fixture }) : '{"path":',
            ),
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
        send({ tool_calls: [toolCall("callA")] });
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
          tool_calls: callIds.map((id, index) => toolCall(id, index)),
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
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const baseUrl = await provider.listen();
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              model: { primary: "openrouter/google/gemini-encrypted-fixture" },
              thinkingDefault: "off",
            },
            entries: { main: {} },
          },
          models: {
            mode: "replace",
            providers: {
              openrouter: {
                baseUrl,
                apiKey: "synthetic-fixture-key",
                api: "openai-completions",
                models: [
                  modelDefinition("google/gemini-encrypted-fixture", {
                    name: "Encrypted fixture",
                    api: "openai-completions",
                    contextWindow: 128000,
                    maxTokens: 4096,
                  }),
                ],
              },
            },
          },
          plugins: { slots: { memory: "none" } },
          logging: { file: path.join(home.tempHome, "gateway.log") },
          gateway: { auth: { mode: "token", token } },
        },
        configPath,
        token,
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
        const { messages } = await gateway.client.request<{ messages: HistoryMessage[] }>(
          "chat.history",
          { sessionKey, limit: 30 },
        );
        const finalText = JSON.stringify(
          messages.findLast(({ role }) => role === "assistant")?.content,
        );
        const toolResults = messages.filter(({ role }) => role === "toolResult");
        if (incomplete()) {
          expect(requests.length).toBeGreaterThan(0);
          expect(
            requests.flatMap((request) => request.messages.filter(({ role }) => role === "tool")),
          ).toEqual([]);
          expect(toolResults).toEqual([]);
          expect(JSON.stringify(messages)).not.toContain('"type":"toolCall"');
          expect(JSON.stringify(messages)).not.toContain(answer);
          expect(waited.status, JSON.stringify({ order, waited, requests: requests.length })).toBe(
            order === "abort" ? "error" : "ok",
          );
          expect(
            requests.flatMap((request) =>
              request.messages.filter(({ reasoning_details }) => reasoning_details !== undefined),
            ),
          ).toEqual([]);
          if (order !== "abort") {
            expect(requests).toHaveLength(2);
            expect(finalText).toContain(rejectedAnswer);
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
          messages.find(
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
        expect(finalText).not.toContain(detail.data);
        expect(waited.status).toBe("ok");
        expect(requests).toHaveLength(2);
        expect(toolResults).toHaveLength(callIds.length);
        expect(finalText).toContain(answer);
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "chat",
            payload: expect.objectContaining({ runId: started.runId, state: "final" }),
          }),
        );
      }
    } finally {
      await provider.close();
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close();
      }
    }
  },
);

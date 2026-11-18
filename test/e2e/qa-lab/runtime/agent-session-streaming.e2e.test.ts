import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { respondJson } from "../../../helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectOperator,
  messageRole,
  messageText,
  startSessionGateway,
} from "./agent-session.test-support.js";
import {
  closeNativeProvider,
  createNativeProvider,
  listenNativeProvider,
} from "./native-provider-proof-fixture.js";

const SESSION_KEY = "agent:qa:qa:session-streaming";
const IDEMPOTENCY_KEY = "qa-session-streaming";
const STREAM_DELTAS = ["SESSION-", "STREAMING-", "OK"] as const;
const TERMINAL_TEXT = STREAM_DELTAS.join("");
type RunEvent = {
  runId?: string;
  sessionKey?: string;
  seq?: number;
  stream?: string;
  data?: { delta?: string; phase?: string };
  state?: string;
  deltaText?: string;
};
function writeEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function writeStreamingResponse(
  response: ServerResponse,
  firstDeltaObserved: ReturnType<typeof createDeferred<void>>,
  terminalRelease: ReturnType<typeof createDeferred<void>>,
): Promise<void> {
  const message = {
    type: "message",
    id: "qa-session-streaming-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: TERMINAL_TEXT, annotations: [] }],
  };
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.flushHeaders();
  writeEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...message, status: "in_progress", content: [] },
  });
  for (const delta of STREAM_DELTAS) {
    writeEvent(response, {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta,
    });
    if (delta === STREAM_DELTAS[0]) {
      await firstDeltaObserved.promise;
    }
  }
  await terminalRelease.promise;
  writeEvent(response, {
    type: "response.output_text.done",
    item_id: message.id,
    output_index: 0,
    content_index: 0,
    text: TERMINAL_TEXT,
  });
  writeEvent(response, { type: "response.output_item.done", output_index: 0, item: message });
  writeEvent(response, {
    type: "response.completed",
    response: {
      id: "qa-session-streaming-response",
      status: "completed",
      output: [message],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  response.end("data: [DONE]\n\n");
}

it(
  "orders Gateway deltas before one terminal event and persists one assistant message",
  { timeout: 120_000 },
  async () => {
    const firstDeltaObserved = createDeferred();
    const terminalRelease = createDeferred();
    const providerRequests: unknown[] = [];
    const transportRequests: string[] = [];
    const server = createNativeProvider(
      async (request, response, body) => {
        if (request.method === "GET" && request.url === "/v1/models") {
          respondJson(response, { data: [{ id: "gpt-5.6-luna", object: "model" }] });
        } else if (request.method === "POST" && request.url === "/v1/responses") {
          providerRequests.push(JSON.parse(body));
          await writeStreamingResponse(response, firstDeltaObserved, terminalRelease);
        } else {
          transportRequests.push(`${request.method ?? "UNKNOWN"} ${request.url ?? ""}`);
          respondJson(response, {});
        }
      },
      (error, response) => {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      },
    );
    const owner = createQaGatewayChild();
    let client: Awaited<ReturnType<typeof connectOperator>> | undefined;
    await runQaGatewayFixture(
      async () => {
        const providerUrl = (await listenNativeProvider(server)).replace(/\/v1$/, "");
        const gateway = await startSessionGateway(owner, providerUrl, {
          useRepoCli: false,
          transportBaseUrl: providerUrl,
        });
        const events: Array<{ event: string; payload?: unknown }> = [];
        const runEvents = (kind: string) =>
          events
            .flatMap((event) =>
              event.event === kind && event.payload && typeof event.payload === "object"
                ? [event.payload as RunEvent]
                : [],
            )
            .filter((event) => event.runId === IDEMPOTENCY_KEY);
        const agentEvents = () => runEvents("agent");
        const chatEvents = () => runEvents("chat");
        const terminalEvents = () =>
          agentEvents().filter(
            (event) =>
              event.stream === "lifecycle" && ["end", "error"].includes(event.data?.phase ?? ""),
          );
        const waitFor = (assertion: () => void) =>
          vi.waitFor(assertion, { interval: 20, timeout: 20_000 });
        const operator = await connectOperator(gateway, "Session streaming QA operator", {
          onEvent: (event) => events.push(event),
        });
        client = operator;
        await operator.request("sessions.messages.subscribe", { key: SESSION_KEY });
        const accepted = await operator.request("agent", {
          sessionKey: SESSION_KEY,
          message: "Return exactly SESSION-STREAMING-OK.",
          deliver: false,
          idempotencyKey: IDEMPOTENCY_KEY,
        });
        expect(accepted).toMatchObject({ status: "accepted", runId: IDEMPOTENCY_KEY });
        await waitFor(() =>
          expect(
            agentEvents().some(
              (event) => event.stream === "assistant" && event.data?.delta === STREAM_DELTAS[0],
            ),
          ).toBe(true),
        );
        firstDeltaObserved.resolve();
        await waitFor(() => {
          expect(terminalEvents()).toHaveLength(0);
          expect(
            chatEvents()
              .filter((event) => event.state === "delta")
              .map((event) => event.deltaText ?? "")
              .join(""),
          ).toBe(TERMINAL_TEXT);
        });
        terminalRelease.resolve();
        expect(
          await operator.request(
            "agent.wait",
            { runId: IDEMPOTENCY_KEY, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        ).toMatchObject({ status: "ok", runId: IDEMPOTENCY_KEY });
        await waitFor(() => expect(terminalEvents()).toHaveLength(1));
        const deltas = agentEvents().filter(
          (event) => event.stream === "assistant" && typeof event.data?.delta === "string",
        );
        expect(deltas.length).toBeGreaterThanOrEqual(2);
        for (const event of deltas) {
          expect(event).toMatchObject({
            runId: IDEMPOTENCY_KEY,
            sessionKey: SESSION_KEY,
            seq: expect.any(Number),
          });
        }
        const seqs = deltas.map((event) => event.seq as number);
        expect(seqs).toEqual([...new Set(seqs)].toSorted((a, b) => a - b));
        expect(terminalEvents()).toMatchObject([
          {
            runId: IDEMPOTENCY_KEY,
            sessionKey: SESSION_KEY,
            stream: "lifecycle",
            data: { phase: "end" },
          },
        ]);
        expect(terminalEvents()[0]?.seq).toBeGreaterThan(seqs.at(-1) ?? 0);
        await waitFor(() =>
          expect(chatEvents().filter((event) => event.state === "final")).toHaveLength(1),
        );
        const finalIndex = chatEvents().findIndex((event) => event.state === "final");
        await delay(250);
        expect(
          chatEvents()
            .slice(finalIndex + 1)
            .some((event) => event.state === "delta"),
        ).toBe(false);
        const streamedText = deltas.map((event) => event.data?.delta ?? "").join("");
        expect(streamedText).toBe(TERMINAL_TEXT);
        const history = await operator.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: SESSION_KEY,
          limit: 20,
        });
        const assistants = (history.messages ?? []).filter(
          (message) => messageRole(message) === "assistant",
        );
        expect(assistants).toHaveLength(1);
        expect(messageText(assistants[0])).toBe(streamedText);
        expect(providerRequests).toHaveLength(1);
        expect(transportRequests).toEqual([]);
      },
      async () => {
        await client?.stopAndWait({ timeoutMs: 1_000 });
      },
      () => stopQaGatewayFixture(owner),
      async () => {
        firstDeltaObserved.resolve();
        terminalRelease.resolve();
        await closeNativeProvider(server);
      },
    );
  },
);

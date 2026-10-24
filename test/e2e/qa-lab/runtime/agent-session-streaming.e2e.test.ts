import { createServer, type ServerResponse } from "node:http";
import { text as readBody } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { respondJson } from "../../../helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectOperator,
  messageRole,
  messageText,
  runCleanups,
  startSessionGateway,
} from "./agent-session.test-support.js";
import { listenLoopback } from "./gateway-recovery.test-support.js";

const TEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SESSION_KEY = "agent:qa:qa:session-streaming";
const IDEMPOTENCY_KEY = "qa-session-streaming";
const REQUEST_MESSAGE = "Return exactly SESSION-STREAMING-OK.";
const STREAM_DELTAS = ["SESSION-", "STREAMING-", "OK"] as const;
const TERMINAL_TEXT = STREAM_DELTAS.join("");

type AgentResult = {
  runId?: string;
  status?: string;
};
type GatewayEvent = {
  event: string;
  payload?: unknown;
};
type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: string;
  deltaText?: string;
};
type AgentEvent = {
  runId?: string;
  sessionKey?: string;
  seq?: number;
  stream?: string;
  data?: {
    delta?: string;
    phase?: string;
    text?: string;
  };
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(() => runCleanups(cleanups, "agent-session-streaming cleanup failed"));

function writeEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function writeStreamingResponse(
  response: ServerResponse,
  deltasSent: ReturnType<typeof createDeferred<void>>,
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
  deltasSent.resolve();
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

async function startStreamingProvider() {
  const providerRequests: Array<Record<string, unknown>> = [];
  const transportRequests: string[] = [];
  const deltasSent = createDeferred();
  const firstDeltaObserved = createDeferred();
  const terminalRelease = createDeferred();
  let terminalReleased = false;
  const releaseTerminal = () => {
    terminalReleased = true;
    terminalRelease.resolve();
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        respondJson(response, { data: [{ id: "gpt-5.6-luna", object: "model" }] });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        providerRequests.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
        await writeStreamingResponse(response, deltasSent, firstDeltaObserved, terminalRelease);
        return;
      }
      transportRequests.push(`${request.method ?? "UNKNOWN"} ${request.url ?? ""}`);
      respondJson(response, {});
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  const baseUrl = await listenLoopback(server, "streaming provider did not bind a loopback port");
  return {
    baseUrl,
    deltasSent: deltasSent.promise,
    releaseRemainingDeltas: firstDeltaObserved.resolve,
    isTerminalReleased: () => terminalReleased,
    releaseTerminal,
    providerRequests,
    transportRequests,
    stop: async () => {
      firstDeltaObserved.resolve();
      releaseTerminal();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function asAgentEvent(event: GatewayEvent): AgentEvent | undefined {
  return event.event === "agent" && event.payload && typeof event.payload === "object"
    ? (event.payload as AgentEvent)
    : undefined;
}

function asChatEvent(event: GatewayEvent): ChatEventPayload | undefined {
  return event.event === "chat" && event.payload && typeof event.payload === "object"
    ? (event.payload as ChatEventPayload)
    : undefined;
}

describe("agent session streaming", () => {
  it(
    "orders Gateway deltas before one terminal event and persists one assistant message",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const provider = await startStreamingProvider();
      cleanups.push(() => provider.stop());
      const gatewayOwner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
      const gateway = await startSessionGateway(gatewayOwner, provider.baseUrl, {
        useRepoCli: false,
        transportBaseUrl: provider.baseUrl,
      });

      const gatewayEvents: GatewayEvent[] = [];
      const agentEvents = () =>
        gatewayEvents
          .map(asAgentEvent)
          .filter((event): event is AgentEvent => event?.runId === IDEMPOTENCY_KEY);
      const chatEvents = () =>
        gatewayEvents.map(asChatEvent).filter((event) => event?.runId === IDEMPOTENCY_KEY);
      const terminalEvents = () =>
        agentEvents().filter(
          (event) =>
            event.stream === "lifecycle" && ["end", "error"].includes(event.data?.phase ?? ""),
        );
      const waitFor = (assertion: () => void) =>
        vi.waitFor(assertion, { interval: 20, timeout: REQUEST_TIMEOUT_MS });
      const client = await connectOperator(gateway, "Session streaming QA operator", {
        onEvent: (event) => gatewayEvents.push(event),
      });
      cleanups.push(() => client.stopAndWait({ timeoutMs: 1_000 }));
      await client.request("sessions.messages.subscribe", { key: SESSION_KEY });
      const accepted = await client.request<AgentResult>("agent", {
        sessionKey: SESSION_KEY,
        message: REQUEST_MESSAGE,
        deliver: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(accepted).toMatchObject({
        status: "accepted",
        runId: IDEMPOTENCY_KEY,
      });

      await waitFor(() =>
        expect(
          agentEvents().some(
            (event) => event.stream === "assistant" && event.data?.delta === STREAM_DELTAS[0],
          ),
        ).toBe(true),
      );
      provider.releaseRemainingDeltas();
      await provider.deltasSent;
      await waitFor(() => {
        expect(provider.isTerminalReleased()).toBe(false);
        const streamedChatText = chatEvents()
          .filter((event) => event?.state === "delta")
          .map((event) => event?.deltaText ?? "")
          .join("");
        expect(streamedChatText).toBe(TERMINAL_TEXT);
      });
      provider.releaseTerminal();

      const terminal = await client.request<AgentResult>(
        "agent.wait",
        { runId: IDEMPOTENCY_KEY, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(terminal).toMatchObject({
        status: "ok",
        runId: IDEMPOTENCY_KEY,
      });

      await waitFor(() => expect(terminalEvents()).toHaveLength(1));

      const assistantDeltas = agentEvents().filter(
        (event) => event.stream === "assistant" && typeof event.data?.delta === "string",
      );
      expect(assistantDeltas.length).toBeGreaterThanOrEqual(2);
      expect(
        assistantDeltas.every(
          (event) =>
            event.runId === accepted.runId &&
            event.sessionKey === SESSION_KEY &&
            typeof event.seq === "number",
        ),
      ).toBe(true);
      const deltaSeqs = assistantDeltas.map((event) => event.seq as number);
      expect(deltaSeqs).toEqual(deltaSeqs.toSorted((left, right) => left - right));
      expect(new Set(deltaSeqs).size).toBe(deltaSeqs.length);

      const terminalAtCompletion = terminalEvents();
      expect(terminalAtCompletion).toHaveLength(1);
      expect(terminalAtCompletion[0]).toMatchObject({
        runId: accepted.runId,
        sessionKey: SESSION_KEY,
        stream: "lifecycle",
        data: { phase: "end" },
      });
      expect(terminalAtCompletion[0]?.seq).toBeGreaterThan(deltaSeqs.at(-1) ?? 0);

      await waitFor(() =>
        expect(chatEvents().filter((event) => event?.state === "final")).toHaveLength(1),
      );
      const runChatEventsAtTerminal = chatEvents();
      const finalIndex = runChatEventsAtTerminal.findIndex((event) => event?.state === "final");
      expect(finalIndex).toBeGreaterThan(-1);
      expect(
        runChatEventsAtTerminal.slice(finalIndex + 1).some((event) => event?.state === "delta"),
      ).toBe(false);
      await delay(250);
      expect(
        chatEvents()
          .slice(finalIndex + 1)
          .some((event) => event?.state === "delta"),
      ).toBe(false);

      const streamedText = assistantDeltas.map((event) => event.data?.delta ?? "").join("");
      expect(streamedText).toBe(TERMINAL_TEXT);

      const history = await client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: SESSION_KEY,
        limit: 20,
      });
      const assistantMessages = (history.messages ?? []).filter(
        (message) => messageRole(message) === "assistant",
      );
      expect(assistantMessages).toHaveLength(1);
      expect(messageText(assistantMessages[0])).toBe(streamedText);
      expect(provider.providerRequests).toHaveLength(1);
      expect(provider.transportRequests).toEqual([]);
    },
  );
});

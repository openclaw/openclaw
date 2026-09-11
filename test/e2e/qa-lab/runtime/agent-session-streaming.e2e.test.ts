import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const TEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 20_000;
const STREAM_INTERVAL_MS = 20;
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const SESSION_KEY = "agent:qa:qa:session-streaming";
const IDEMPOTENCY_KEY = "qa-session-streaming";
const REQUEST_MESSAGE = "Return exactly SESSION-STREAMING-OK.";
const STREAM_DELTAS = ["SESSION-", "STREAMING-", "OK"] as const;
const TERMINAL_TEXT = STREAM_DELTAS.join("");

type GatewayHandle = QaGatewayChild;
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
  seq?: number;
  state?: string;
  deltaText?: string;
  error?: unknown;
  errorMessage?: unknown;
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
    error?: unknown;
  };
};

type StreamingPhase =
  | "provider-start"
  | "gateway-pre-listening"
  | "gateway-post-listening"
  | "gateway-ready"
  | "operator-connect"
  | "subscribe"
  | "acceptance"
  | "provider-deltas"
  | "chat-deltas"
  | "terminal-wait"
  | "lifecycle-events"
  | "chat-final-events"
  | "post-terminal-events"
  | "history"
  | "complete";

const cleanups: Array<() => Promise<void>> = [];
let captureFailure: (() => unknown) | undefined;

function diagnosticLabel(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value) ? value : "other";
}

function summarizeGatewayEvent(event: GatewayEvent) {
  const agent = asAgentEvent(event);
  const chat = asChatEvent(event);
  const payload = agent ?? chat;
  const delta = agent?.data?.delta ?? chat?.deltaText;
  const seq = payload?.seq;
  return {
    event: diagnosticLabel(event.event, ["agent", "chat"]),
    stream: diagnosticLabel(agent?.stream, ["assistant", "lifecycle", "tool", "reasoning"]),
    state: diagnosticLabel(chat?.state, ["delta", "final", "error", "aborted"]),
    phase: diagnosticLabel(agent?.data?.phase, ["start", "end", "error"]),
    runMatches: payload?.runId === IDEMPOTENCY_KEY,
    sessionMatches: payload?.sessionKey === SESSION_KEY,
    seq: typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : null,
    hasDelta: typeof delta === "string",
    deltaLength: typeof delta === "string" ? delta.length : 0,
    hasError:
      agent?.data?.error != null ||
      chat?.error != null ||
      chat?.errorMessage != null ||
      agent?.data?.phase === "error" ||
      chat?.state === "error",
  };
}

function createStreamingDiagnostics() {
  const startedAt = performance.now();
  let phase: StreamingPhase = "provider-start";
  let listeningAttempt: number | null = null;
  const milestones: Partial<Record<StreamingPhase, number>> = { "provider-start": 0 };
  const provider = {
    responsePosts: 0,
    parsedRequests: 0,
    unexpectedTransport: 0,
    deltasSent: false,
    terminalReleased: false,
  };
  const events = { expectedRunAgent: 0, expectedRunChat: 0 };
  const recentEvents: ReturnType<typeof summarizeGatewayEvent>[] = [];
  return {
    provider,
    enterPhase(next: StreamingPhase) {
      phase = next;
      milestones[next] ??= Math.round(performance.now() - startedAt);
    },
    onListening(attempt: number) {
      listeningAttempt = Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : null;
      this.enterPhase("gateway-post-listening");
    },
    observeEvent(event: GatewayEvent) {
      const summary = summarizeGatewayEvent(event);
      if (summary.runMatches && summary.event === "agent") {
        events.expectedRunAgent++;
      }
      if (summary.runMatches && summary.event === "chat") {
        events.expectedRunChat++;
      }
      if (recentEvents.length === 16) {
        recentEvents.shift();
      }
      recentEvents.push(summary);
    },
    snapshot: () => ({
      diagnostic: "session-streaming-failure",
      phase,
      elapsedMs: Math.round(performance.now() - startedAt),
      milestones: { ...milestones },
      listeningAttempt,
      provider: { ...provider },
      events: { ...events },
      recentEvents: [...recentEvents],
    }),
  };
}

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(async (context) => {
  // Snapshot before cleanup releases the provider terminal or changes event state.
  if (context.task.result?.state === "fail" && captureFailure) {
    try {
      console.error(JSON.stringify(captureFailure()));
    } catch {
      // Diagnostic failure must not replace the test failure or skip cleanup.
    }
  }
  captureFailure = undefined;
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "session streaming cleanup failed");
  }
});

function writeEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function writeStreamingResponse(
  response: ServerResponse,
  deltasSent: ReturnType<typeof createDeferred>,
  terminalRelease: ReturnType<typeof createDeferred>,
  diagnostics: ReturnType<typeof createStreamingDiagnostics>,
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
    await delay(STREAM_INTERVAL_MS);
  }
  diagnostics.provider.deltasSent = true;
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

async function startStreamingProvider(diagnostics: ReturnType<typeof createStreamingDiagnostics>) {
  const providerRequests: Array<Record<string, unknown>> = [];
  const transportRequests: string[] = [];
  const deltasSent = createDeferred();
  const terminalRelease = createDeferred();
  let terminalReleased = false;
  const releaseTerminal = () => {
    diagnostics.provider.terminalReleased = true;
    terminalReleased = true;
    terminalRelease.resolve();
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [{ id: "gpt-5.6-luna", object: "model" }],
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        diagnostics.provider.responsePosts++;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        providerRequests.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        );
        diagnostics.provider.parsedRequests++;
        await writeStreamingResponse(response, deltasSent, terminalRelease, diagnostics);
        return;
      }
      diagnostics.provider.unexpectedTransport++;
      transportRequests.push(`${request.method ?? "UNKNOWN"} ${request.url ?? ""}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("streaming provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    deltasSent: deltasSent.promise,
    isTerminalReleased: () => terminalReleased,
    releaseTerminal,
    providerRequests,
    transportRequests,
    stop: async () => {
      releaseTerminal();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function connectOperator(
  gateway: GatewayHandle,
  events: GatewayEvent[],
  diagnostics: ReturnType<typeof createStreamingDiagnostics>,
): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
        return;
      }
      resolve(client);
    };
    const client = new GatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      env: gateway.runtimeEnv,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Session streaming QA operator",
      clientVersion: "1.0.0",
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      deviceIdentity: null,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onEvent: (event) => {
        events.push(event);
        diagnostics.observeEvent(event);
      },
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () => finish(new Error(`Gateway client connection timed out after ${REQUEST_TIMEOUT_MS}ms`)),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    client.start();
  });
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

function messageRole(message: unknown): string | undefined {
  const role = message && typeof message === "object" ? (message as { role?: unknown }).role : null;
  return typeof role === "string" ? role : undefined;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}

describe("agent session streaming", () => {
  it(
    "orders Gateway deltas before one terminal event and persists one assistant message",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const diagnostics = createStreamingDiagnostics();
      captureFailure = diagnostics.snapshot;
      const provider = await startStreamingProvider(diagnostics);
      cleanups.push(() => provider.stop());
      const gatewayOwner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
      diagnostics.enterPhase("gateway-pre-listening");
      const gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: ["dist/entry.js"],
          cwd: process.cwd(),
          usePackagedPlugins: true,
        },
        providerBaseUrl: `${provider.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL_REF,
        alternateModel: MODEL_REF,
        transportBaseUrl: provider.baseUrl,
        controlUiEnabled: false,
        fastMode: true,
        runtimeEnvPatch: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        },
        mutateConfig: (config) => ({ ...config, plugins: { enabled: false } }),
        onListening: ({ attempt }) => diagnostics.onListening(attempt),
      });
      diagnostics.enterPhase("gateway-ready");

      const gatewayEvents: GatewayEvent[] = [];
      diagnostics.enterPhase("operator-connect");
      const client = await connectOperator(gateway, gatewayEvents, diagnostics);
      cleanups.push(() => client.stopAndWait({ timeoutMs: 1_000 }));
      diagnostics.enterPhase("subscribe");
      await client.request("sessions.messages.subscribe", { key: SESSION_KEY });
      diagnostics.enterPhase("acceptance");
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

      diagnostics.enterPhase("provider-deltas");
      await provider.deltasSent;
      diagnostics.enterPhase("chat-deltas");
      await vi.waitFor(
        () => {
          expect(provider.isTerminalReleased()).toBe(false);
          const streamedChatText = gatewayEvents
            .map(asChatEvent)
            .filter((event) => event?.runId === IDEMPOTENCY_KEY && event.state === "delta")
            .map((event) => event?.deltaText ?? "")
            .join("");
          expect(streamedChatText).toBe(TERMINAL_TEXT);
        },
        { interval: 20, timeout: REQUEST_TIMEOUT_MS },
      );
      provider.releaseTerminal();

      diagnostics.enterPhase("terminal-wait");
      const terminal = await client.request<AgentResult>(
        "agent.wait",
        { runId: IDEMPOTENCY_KEY, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(terminal).toMatchObject({
        status: "ok",
        runId: IDEMPOTENCY_KEY,
      });

      diagnostics.enterPhase("lifecycle-events");
      await vi.waitFor(
        () => {
          const runEvents = gatewayEvents
            .map(asAgentEvent)
            .filter((event): event is AgentEvent => event?.runId === IDEMPOTENCY_KEY);
          expect(
            runEvents.filter(
              (event) =>
                event.stream === "lifecycle" &&
                (event.data?.phase === "end" || event.data?.phase === "error"),
            ),
          ).toHaveLength(1);
        },
        { interval: 20, timeout: REQUEST_TIMEOUT_MS },
      );

      const runEvents = gatewayEvents
        .map(asAgentEvent)
        .filter((event): event is AgentEvent => event?.runId === IDEMPOTENCY_KEY);
      const assistantDeltas = runEvents.filter(
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

      const terminalEvents = runEvents.filter(
        (event) =>
          event.stream === "lifecycle" &&
          (event.data?.phase === "end" || event.data?.phase === "error"),
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        runId: accepted.runId,
        sessionKey: SESSION_KEY,
        stream: "lifecycle",
        data: { phase: "end" },
      });
      expect(terminalEvents[0]?.seq).toBeGreaterThan(deltaSeqs.at(-1) ?? 0);

      diagnostics.enterPhase("chat-final-events");
      await vi.waitFor(
        () => {
          const runChatEvents = gatewayEvents
            .map(asChatEvent)
            .filter((event) => event?.runId === IDEMPOTENCY_KEY);
          expect(runChatEvents.filter((event) => event?.state === "final")).toHaveLength(1);
        },
        { interval: 20, timeout: REQUEST_TIMEOUT_MS },
      );
      diagnostics.enterPhase("post-terminal-events");
      const runChatEventsAtTerminal = gatewayEvents
        .map(asChatEvent)
        .filter((event) => event?.runId === IDEMPOTENCY_KEY);
      const finalIndex = runChatEventsAtTerminal.findIndex((event) => event?.state === "final");
      expect(finalIndex).toBeGreaterThan(-1);
      expect(
        runChatEventsAtTerminal.slice(finalIndex + 1).some((event) => event?.state === "delta"),
      ).toBe(false);
      await delay(250);
      expect(
        gatewayEvents
          .map(asChatEvent)
          .filter((event) => event?.runId === IDEMPOTENCY_KEY)
          .slice(finalIndex + 1)
          .some((event) => event?.state === "delta"),
      ).toBe(false);

      const streamedText = assistantDeltas.map((event) => event.data?.delta ?? "").join("");
      expect(streamedText).toBe(TERMINAL_TEXT);

      diagnostics.enterPhase("history");
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
      diagnostics.enterPhase("complete");
    },
  );
});

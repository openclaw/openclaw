import { createServer, type Server, type ServerResponse } from "node:http";
import type { Context, Model, StreamFn } from "@openclaw/llm-core";
import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "../../packages/ai/src/transports/openai-responses-client.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import {
  classifySessionAttention,
  isRepeatedModelRequestStalled,
} from "./diagnostic-session-attention.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

const REQUEST_TIMEOUT_MS = 1_000;
const STUCK_ABORT_MS = 500;
const OWNER_START_MS = Date.parse("2026-10-04T00:00:00.000Z");

type FixtureOutcome = { stopReason?: string; error?: unknown };

type ResponsesLoopbackFixture = {
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  firstRequestReceived: Promise<void>;
  secondRequestReceived: Promise<void>;
  failFirstRequest(): void;
  completeSecondRequest(): void;
  close(): Promise<void>;
};

function completedFrame() {
  return {
    type: "response.completed",
    response: {
      id: "loopback-response-2",
      status: "completed",
      output: [
        {
          id: "loopback-message-2",
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text: "synthetic answer", annotations: [] }],
          role: "assistant",
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

async function createResponsesLoopbackFixture(): Promise<ResponsesLoopbackFixture> {
  const requests: Array<Record<string, unknown>> = [];
  const firstRequest = createDeferred();
  const secondRequest = createDeferred();
  let firstResponse: ServerResponse | undefined;
  let secondResponse: ServerResponse | undefined;
  const server: Server = createServer((request, response) => {
    response.on("error", () => {});
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404);
      response.end();
      return;
    }
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      if (requests.length === 1) {
        firstResponse = response;
        firstRequest.resolve();
        return;
      }
      if (requests.length === 2) {
        secondResponse = response;
        secondRequest.resolve();
        return;
      }
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unexpected extra loopback request" } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string" || !isLoopbackIpAddress(address.address)) {
    throw new Error("Expected the Responses fixture to own an ephemeral loopback port");
  }
  const host = address.family === "IPv6" ? "[" + address.address + "]" : address.address;
  return {
    baseUrl: "http://" + host + ":" + address.port + "/v1",
    requests,
    firstRequestReceived: firstRequest.promise,
    secondRequestReceived: secondRequest.promise,
    failFirstRequest() {
      if (!firstResponse) {
        throw new Error("First real HTTP request was not received");
      }
      firstResponse.destroy();
    },
    completeSecondRequest() {
      if (!secondResponse) {
        throw new Error("Second real HTTP request was not received");
      }
      secondResponse.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      secondResponse.write("data: " + JSON.stringify(completedFrame()) + "\n\n");
      secondResponse.end();
    },
    async close() {
      if (firstResponse && !firstResponse.writableEnded) {
        firstResponse.destroy();
      }
      if (secondResponse && !secondResponse.writableEnded) {
        secondResponse.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function createModel(baseUrl: string): Model<"openai-responses"> {
  return {
    id: "loopback-responses-model",
    name: "Loopback Responses model",
    api: "openai-responses",
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 128,
    [Symbol.for("openclaw.modelProviderRequestTransport")]: { allowPrivateNetwork: true },
  } as Model<"openai-responses">;
}

function createObservedStreamFn(params: {
  model: Model<"openai-responses">;
  runId: string;
  sessionId: string;
  sessionKey: string;
  owner: ReturnType<typeof createDiagnosticEmbeddedRunOwner>;
}): StreamFn {
  let callSequence = 0;
  return wrapStreamFnWithDiagnosticModelCallEvents(createOpenAIResponsesTransportStreamFn(), {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.model.provider,
    model: params.model.id,
    api: params.model.api,
    transport: "sse",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => params.runId + ":model:" + ++callSequence,
    ownerGeneration: params.owner.generation,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    suppressPluginHooks: true,
  });
}

async function settleModelStream(streamValue: ReturnType<StreamFn>): Promise<FixtureOutcome> {
  try {
    const stream = await streamValue;
    for await (const event of stream) {
      // Observe actual SDK events, not just a precomputed result or synthetic formula.
      expect(event.type).toBeDefined();
    }
    const result = await stream.result();
    return { stopReason: result.stopReason };
  } catch (error) {
    return { error };
  }
}

function createContext(): Context {
  return {
    messages: [{ role: "user", content: "Return a short synthetic response.", timestamp: 1 }],
  };
}

function streamOptions(signal: AbortSignal): NonNullable<Parameters<StreamFn>[2]> {
  return {
    apiKey: "loopback-fixture-key",
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    transport: "sse",
  };
}

function expectFailedOutcome(outcome: FixtureOutcome) {
  expect(
    outcome.stopReason === "error" ||
      outcome.stopReason === "aborted" ||
      outcome.error !== undefined,
  ).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  resetCommandQueueStateForTest();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  setDiagnosticsEnabledForProcess(false);
});

describe("Responses request deadline recovery at real HTTP", () => {
  it("preserves the current retry allowance, then recovers the registered owner", async ({
    signal,
  }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OWNER_START_MS);
    setDiagnosticsEnabledForProcess(true);
    const fixture = await createResponsesLoopbackFixture();
    const ref = {
      runId: "responses-deadline-run",
      sessionId: "responses-deadline-session",
      sessionKey: "agent:main:responses-deadline",
    };
    const owner = createDiagnosticEmbeddedRunOwner(ref);
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, owner });
    const model = createModel(fixture.baseUrl);
    const streamFn = createObservedStreamFn({ ...ref, owner, model });
    const context = createContext();
    const activeEntered = createDeferred();
    const releaseActive = createDeferred();
    let requestController: AbortController | undefined;
    let secondCallSettled = false;
    const firstController = new AbortController();
    let firstSettlement: Promise<FixtureOutcome> | undefined;
    let secondSettlement: Promise<FixtureOutcome> | undefined;
    const handle = {
      runId: ref.runId,
      diagnosticOwner: owner,
      closeDiagnostics: () => closeDiagnosticEmbeddedRunOwner(owner),
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(() => {
        requestController?.abort(new Error("diagnostic owner cancellation"));
        releaseActive.resolve();
      }),
    };
    const lane = resolveEmbeddedSessionLane(ref.sessionKey);
    const activeRun = enqueueCommandInLane(lane, async () => {
      setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
      activeEntered.resolve();
      try {
        await releaseActive.promise;
        const settlement = secondSettlement ?? firstSettlement;
        if (settlement) {
          await settlement;
        }
        await waitForDiagnosticEventsDrained();
      } finally {
        clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
      }
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          activeEntered.promise,
          activeRun,
          "owner settled before registration",
        ),
        signal,
      );
      requestController = firstController;
      firstSettlement = settleModelStream(
        streamFn(model, context, streamOptions(firstController.signal)),
      );
      await withinTest(
        awaitGateBeforeSettlement(
          fixture.firstRequestReceived,
          firstSettlement,
          "request settled before first HTTP entry",
        ),
        signal,
      );
      expect(fixture.requests).toHaveLength(1);

      // Keep the first socket open while the diagnostic recovery allowance elapses,
      // then fail it at the boundary to model the network reset that starts the retry.
      vi.setSystemTime(OWNER_START_MS + REQUEST_TIMEOUT_MS);
      fixture.failFirstRequest();
      expectFailedOutcome(await withinTest(firstSettlement, signal));
      await waitForDiagnosticEventsDrained();
      expect(
        getDiagnosticSessionActivitySnapshot(ref).activeModelCallRecoveryDeadlineAtMs,
      ).toBeUndefined();

      requestController = new AbortController();
      secondSettlement = settleModelStream(
        streamFn(model, context, streamOptions(requestController.signal)),
      ).finally(() => {
        secondCallSettled = true;
      });
      await withinTest(
        awaitGateBeforeSettlement(
          fixture.secondRequestReceived,
          secondSettlement,
          "request settled before second HTTP entry",
        ),
        signal,
      );
      await waitForDiagnosticEventsDrained();
      expect(fixture.requests).toHaveLength(2);
      expect(secondCallSettled).toBe(false);

      const activity = getDiagnosticSessionActivitySnapshot(ref);
      expect(activity.repeatedRequestNoProgressAgeMs).toBe(REQUEST_TIMEOUT_MS);
      expect(activity.activeModelCallRecoveryDeadlineAtMs).toBe(
        OWNER_START_MS + 2 * REQUEST_TIMEOUT_MS,
      );
      expect(
        classifySessionAttention({
          state: "processing",
          queueDepth: 1,
          activity,
          staleMs: 30_000,
          stuckSessionAbortMs: STUCK_ABORT_MS,
        }),
      ).toMatchObject({
        eventType: "session.stalled",
        reason: "repeated_model_requests_without_progress",
      });

      const beforeDeadline = await recoverStuckDiagnosticSession({
        sessionKey: ref.sessionKey,
        ageMs: REQUEST_TIMEOUT_MS,
        queueDepth: 1,
        allowActiveAbort: true,
        repeatedRequestNoProgressAbortMs: STUCK_ABORT_MS,
      });
      expect(beforeDeadline).toMatchObject({ status: "skipped", reason: "active_embedded_run" });
      expect(handle.abort).not.toHaveBeenCalled();
      expect(secondCallSettled).toBe(false);

      vi.setSystemTime(OWNER_START_MS + 2 * REQUEST_TIMEOUT_MS);
      const exhaustedActivity = getDiagnosticSessionActivitySnapshot(ref);
      expect(isRepeatedModelRequestStalled(exhaustedActivity, STUCK_ABORT_MS)).toBe(true);
      expect(secondCallSettled).toBe(false);

      const recovered = await withinTest(
        recoverStuckDiagnosticSession({
          sessionKey: ref.sessionKey,
          ageMs: 2 * REQUEST_TIMEOUT_MS,
          queueDepth: 1,
          allowActiveAbort: true,
          repeatedRequestNoProgressAbortMs: STUCK_ABORT_MS,
        }),
        signal,
      );
      expect(recovered).toMatchObject({ status: "aborted", action: "abort_embedded_run" });
      expect(handle.abort).toHaveBeenCalledOnce();
      expectFailedOutcome(await withinTest(secondSettlement, signal));
      await waitForDiagnosticEventsDrained();
      expect(fixture.requests).toHaveLength(2);
    } finally {
      firstController.abort(new Error("test cleanup"));
      requestController?.abort(new Error("test cleanup"));
      releaseActive.resolve();
      try {
        if (secondSettlement && !secondCallSettled) {
          await withinTest(secondSettlement, signal);
        }
        if (firstSettlement) {
          await withinTest(firstSettlement, signal);
        }
        await withinTest(activeRun, signal);
      } finally {
        clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
        closeDiagnosticEmbeddedRunOwner(owner);
        await fixture.close();
      }
    }
  });

  it("clears cumulative no-progress age after a real semantic Responses result", async ({
    signal,
  }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OWNER_START_MS);
    setDiagnosticsEnabledForProcess(true);
    const fixture = await createResponsesLoopbackFixture();
    const ref = {
      runId: "responses-semantic-run",
      sessionId: "responses-semantic-session",
      sessionKey: "agent:main:responses-semantic",
    };
    const owner = createDiagnosticEmbeddedRunOwner(ref);
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, owner });
    const model = createModel(fixture.baseUrl);
    const streamFn = createObservedStreamFn({ ...ref, owner, model });
    const firstController = new AbortController();
    const secondController = new AbortController();
    let firstSettlement: Promise<FixtureOutcome> | undefined;
    let secondSettlement: Promise<FixtureOutcome> | undefined;
    try {
      const context = createContext();
      firstSettlement = settleModelStream(
        streamFn(model, context, streamOptions(firstController.signal)),
      );
      await withinTest(
        awaitGateBeforeSettlement(
          fixture.firstRequestReceived,
          firstSettlement,
          "request settled before first HTTP entry",
        ),
        signal,
      );
      vi.setSystemTime(OWNER_START_MS + REQUEST_TIMEOUT_MS);
      fixture.failFirstRequest();
      expectFailedOutcome(await withinTest(firstSettlement, signal));
      await waitForDiagnosticEventsDrained();

      const second = streamFn(model, context, streamOptions(secondController.signal));
      secondSettlement = settleModelStream(second);
      await withinTest(
        awaitGateBeforeSettlement(
          fixture.secondRequestReceived,
          secondSettlement,
          "request settled before second HTTP entry",
        ),
        signal,
      );
      vi.setSystemTime(OWNER_START_MS + REQUEST_TIMEOUT_MS + 100);
      fixture.completeSecondRequest();
      const completed = await withinTest(secondSettlement, signal);
      expect(completed.stopReason).toBe("stop");
      await waitForDiagnosticEventsDrained();
      expect(fixture.requests).toHaveLength(2);
      expect(
        getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
      ).toBeUndefined();
    } finally {
      firstController.abort(new Error("test cleanup"));
      secondController.abort(new Error("test cleanup"));
      try {
        if (firstSettlement) {
          await withinTest(firstSettlement, signal);
        }
        if (secondSettlement) {
          await withinTest(secondSettlement, signal);
        }
      } finally {
        closeDiagnosticEmbeddedRunOwner(owner);
        await fixture.close();
      }
    }
  });
});

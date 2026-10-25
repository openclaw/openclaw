import { createServer, type ServerResponse } from "node:http";
import type { Context, StreamFn } from "@openclaw/llm-core";
import { afterEach, expect, it, vi } from "vitest";
import { makeOpenAIProviderModel } from "../../packages/ai/src/providers/openai-provider.test-support.js";
import { createOpenAIResponsesTransportStreamFn } from "../../packages/ai/src/transports/openai-responses-client.js";
import {
  completed,
  message,
  outputItem,
  outputTextDelta,
  outputTextPart,
  startedMessage,
} from "../../packages/ai/src/transports/openai-responses-stream-parity.test-helpers.js";
import { readRequestText, respondJson } from "../../test/helpers/gateway-integration-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import { runWithModelFallback } from "../agents/model-fallback-runner.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

const REQUEST_TIMEOUT_MS = 10 * 60_000;
const STUCK_ABORT_MS = 5 * 60_000;
const OWNER_START_MS = Date.parse("2026-10-04T00:00:00.000Z");

type FixtureOutcome = { stopReason?: string; errorMessage?: string; error?: unknown };
type FallbackSettlement = {
  result?: Awaited<ReturnType<typeof runWithModelFallback<FixtureOutcome>>>;
  error?: unknown;
};

async function createResponsesFallbackFixture(signal: AbortSignal) {
  const responses: ServerResponse[] = [];
  const received = [createDeferred(), createDeferred(), createDeferred()];
  const server = createServer(async (request, response) => {
    response.on("error", () => {});
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404);
      response.end();
      return;
    }
    await readRequestText(request);
    const index = responses.length;
    responses.push(response);
    if (index >= received.length) {
      respondJson(response, { error: { message: "unexpected extra loopback request" } }, 503);
      return;
    }
    received[index]!.resolve();
  });
  const { claim, releaseListener } = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () => server,
  });
  const responseAt = (index: number) => {
    const response = responses[index];
    if (!response) {
      throw new Error("Expected actual HTTP request " + (index + 1));
    }
    return response;
  };
  const writeFrame = (response: ServerResponse, frame: unknown) => {
    response.write("data: " + JSON.stringify(frame) + "\n\n");
  };
  return {
    baseUrl: "http://127.0.0.1:" + claim.port + "/v1",
    get requestCount() {
      return responses.length;
    },
    received: received.map((gate) => gate.promise),
    failRequest(index: number) {
      responseAt(index).destroy();
    },
    startFallbackStream() {
      const response = responseAt(2);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeFrame(response, {
        type: "response.created",
        response: { id: "fallback-response", status: "in_progress", output: [] },
      });
      writeFrame(response, outputItem("added", startedMessage("fallback-message"), 0));
      writeFrame(response, outputTextPart("fallback-message"));
      writeFrame(response, outputTextDelta("fallback-message", "synthetic"));
    },
    completeFallbackStream() {
      const response = responseAt(2);
      writeFrame(response, outputTextDelta("fallback-message", " answer"));
      writeFrame(
        response,
        completed("fallback-response", [message("fallback-message", "synthetic answer")]),
      );
      response.end();
    },
    async close() {
      for (const response of responses) {
        if (!response.writableEnded) {
          response.destroy();
        }
      }
      server.closeAllConnections();
      try {
        await releaseListener();
      } finally {
        await claim.release();
      }
    },
  };
}

const modelSettings = { reasoning: false, contextWindow: 8_192, maxTokens: 128 };
function createModel(baseUrl: string, provider: string, id: string) {
  return Object.assign(
    makeOpenAIProviderModel("openai-responses", {
      ...modelSettings,
      id,
      name: id,
      provider,
      baseUrl,
    }),
    { [Symbol.for("openclaw.modelProviderRequestTransport")]: { allowPrivateNetwork: true } },
  );
}

async function settleModelStream(
  streamValue: ReturnType<StreamFn>,
  onStreamingStart?: () => void,
): Promise<FixtureOutcome> {
  try {
    const stream = await streamValue;
    for await (const event of stream) {
      if (event.type === "text_delta") {
        onStreamingStart?.();
      }
    }
    const result = await stream.result();
    return { stopReason: result.stopReason, errorMessage: result.errorMessage };
  } catch (error) {
    return { error };
  }
}

afterEach(() => {
  vi.useRealTimers();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  setDiagnosticsEnabledForProcess(false);
});

it.for(["success", "expiry"] as const)(
  "preserves the fallback allowance through %s",
  async (terminal, { signal }) => {
    const wait = <T>(promise: Promise<T>) => withinTest(promise, signal);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OWNER_START_MS);
    setDiagnosticsEnabledForProcess(true);
    const fixture = await createResponsesFallbackFixture(signal);
    const ref = {
      runId: "fallback-" + terminal,
      sessionId: "fallback-session-" + terminal,
      sessionKey: "agent:main:fallback-" + terminal,
    };
    const operation = createReplyOperation({ ...ref, resetTriggered: false });
    operation.setPhase("running");
    const watchdogAttempt = operation.watchdog.attachAttempt({
      assertCurrent: () => operation.abortSignal.throwIfAborted(),
    });
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, watchdogAttempt });
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, owner });
    const controller = new AbortController();
    const streamingStarted = createDeferred();
    const context: Context = {
      messages: [{ role: "user", content: "Return a short synthetic response.", timestamp: 1 }],
    };
    let callSequence = 0;
    let chainSettled = false;
    const handle = {
      kind: "embedded" as const,
      runId: ref.runId,
      diagnosticOwner: owner,
      closeDiagnostics: () => closeDiagnosticEmbeddedRunOwner(owner),
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(() => {
        controller.abort(new Error("diagnostic owner cancellation"));
      }),
    };
    let chain: Promise<FallbackSettlement> | undefined;
    attachActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey, undefined, undefined, operation);
    const releaseCleanup = operation.registerExecutionCleanup(async () => {
      await chain;
      await waitForDiagnosticEventsDrained();
      detachActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
      operation.complete();
    });
    const waitForStage = (gate: Promise<unknown>, description: string) =>
      wait(awaitGateBeforeSettlement(gate, chain!, description));
    try {
      chain = runWithModelFallback<FixtureOutcome>({
        cfg: undefined,
        provider: "synthetic-primary",
        model: "first",
        fallbacksOverride: ["synthetic-primary/retry", "ollama/local-response"],
        requestedRouteResolution: "resolved",
        skipAuthProfileRuntime: true,
        ...ref,
        abortSignal: controller.signal,
        run: async (provider, modelId) => {
          const model = createModel(fixture.baseUrl, provider, modelId);
          const streamFn = wrapStreamFnWithDiagnosticModelCallEvents(
            createOpenAIResponsesTransportStreamFn(),
            {
              ...ref,
              provider,
              model: modelId,
              api: model.api,
              transport: "sse",
              trace: createDiagnosticTraceContext(),
              nextCallId: () => ref.runId + ":model:" + ++callSequence,
              ownerGeneration: owner.generation,
              diagnosticOwner: owner,
              requestTimeoutMs: REQUEST_TIMEOUT_MS,
              suppressPluginHooks: true,
            },
          );
          return settleModelStream(
            streamFn(model, context, {
              apiKey: "loopback-fixture-key",
              signal: controller.signal,
              timeoutMs: REQUEST_TIMEOUT_MS,
              transport: "sse",
            }),
            provider === "ollama" ? () => streamingStarted.resolve() : undefined,
          );
        },
        classifyResult: ({ result }) => {
          if (result.error !== undefined) {
            return { error: result.error };
          }
          if (result.stopReason === "error" || result.stopReason === "aborted") {
            return {
              message: result.errorMessage ?? "Loopback model request failed",
              reason: "timeout",
            };
          }
          return null;
        },
      })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          chainSettled = true;
        });

      // The fallback owner advances both failed candidates automatically; the test controls only HTTP settlement and Date.
      for (const index of [0, 1]) {
        await waitForStage(fixture.received[index]!, "chain settled before failed HTTP request");
        await waitForDiagnosticEventsDrained();
        vi.setSystemTime(OWNER_START_MS + (index + 1) * REQUEST_TIMEOUT_MS);
        fixture.failRequest(index);
      }
      await waitForStage(fixture.received[2]!, "chain settled before fallback HTTP request");
      fixture.startFallbackStream();
      await waitForStage(streamingStarted.promise, "fallback settled before streamed start");
      await waitForDiagnosticEventsDrained();
      const fallbackStartedAt = OWNER_START_MS + 2 * REQUEST_TIMEOUT_MS;
      vi.setSystemTime(fallbackStartedAt + 250);
      const activity = getDiagnosticSessionActivitySnapshot(ref);
      expect(activity).toMatchObject({
        repeatedRequestNoProgressAgeMs: REQUEST_TIMEOUT_MS + 250,
        lastProgressReason: "model_call:stream_progress",
        activeModelCallRequestTimeoutMs: REQUEST_TIMEOUT_MS,
      });
      expect(operation.watchdog.decide().action).not.toBe("stop");
      const recover = () =>
        recoverStuckDiagnosticSession({
          operation,
          sessionKey: ref.sessionKey,
          ageMs: Date.now() - OWNER_START_MS,
          queueDepth: 1,
          allowActiveAbort: true,
          repeatedRequestNoProgressAbortMs: STUCK_ABORT_MS,
        });
      expect(await recover()).toMatchObject({ status: "skipped", reason: "active_reply_work" });
      expect(handle.abort).not.toHaveBeenCalled();
      expect(chainSettled).toBe(false);

      if (terminal === "success") {
        fixture.completeFallbackStream();
        const settled = await wait(chain);
        expect(settled).toMatchObject({
          result: {
            outcome: "completed",
            provider: "ollama",
            model: "local-response",
            result: { stopReason: "stop" },
          },
        });
        expect(settled.result?.attempts).toHaveLength(2);
        await waitForDiagnosticEventsDrained();
        expect(
          getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
        ).toBeUndefined();
        expect(handle.abort).not.toHaveBeenCalled();
      } else {
        vi.setSystemTime(fallbackStartedAt + REQUEST_TIMEOUT_MS);
        expect(operation.watchdog.decide()).toMatchObject({
          action: "stop",
          reason: "semantic_stall",
          deadlineAtMs: fallbackStartedAt + REQUEST_TIMEOUT_MS,
        });
        expect(await wait(recover())).toMatchObject({
          status: "aborted",
          action: "abort_embedded_run",
        });
        expect(handle.abort).toHaveBeenCalledOnce();
        expect((await wait(chain)).error).toBeDefined();
      }
      expect(fixture.requestCount).toBe(3);
    } finally {
      controller.abort(new Error("test cleanup"));
      try {
        if (chain) {
          await wait(chain);
        }
      } finally {
        releaseCleanup();
        detachActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
        operation.complete();
        closeDiagnosticEmbeddedRunOwner(owner);
        await fixture.close();
      }
    }
  },
);

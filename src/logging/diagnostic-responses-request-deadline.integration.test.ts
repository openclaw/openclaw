import { createServer, type ServerResponse } from "node:http";
import type { Context, Model, StreamFn } from "@openclaw/llm-core";
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
import { runWithModelFallback } from "../agents/model-fallback-runner.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
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

type FixtureOutcome = { stopReason?: string; errorMessage?: string; error?: unknown };

async function createResponsesFallbackFixture(signal: AbortSignal) {
  const requests: Array<Record<string, unknown>> = [];
  const responses: ServerResponse[] = [];
  const received = [createDeferred(), createDeferred(), createDeferred()];
  const server = createServer((request, response) => {
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
      const index = requests.length;
      requests.push(JSON.parse(body) as Record<string, unknown>);
      responses.push(response);
      if (index >= received.length) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unexpected extra loopback request" } }));
        return;
      }
      received[index]!.resolve();
    });
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
    requests,
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
      writeFrame(response, {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fallback-message",
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      });
      writeFrame(response, {
        type: "response.content_part.added",
        item_id: "fallback-message",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      writeFrame(response, {
        type: "response.output_text.delta",
        item_id: "fallback-message",
        output_index: 0,
        content_index: 0,
        delta: "synthetic",
      });
    },
    completeFallbackStream() {
      const response = responseAt(2);
      writeFrame(response, {
        type: "response.output_text.delta",
        item_id: "fallback-message",
        output_index: 0,
        content_index: 0,
        delta: " answer",
      });
      writeFrame(response, {
        type: "response.completed",
        response: {
          id: "fallback-response",
          status: "completed",
          output: [
            {
              id: "fallback-message",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "synthetic answer", annotations: [] }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      });
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

function createModel(baseUrl: string, provider: string, id: string): Model<"openai-responses"> {
  return {
    id,
    provider,
    baseUrl,
    name: id,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 128,
    [Symbol.for("openclaw.modelProviderRequestTransport")]: { allowPrivateNetwork: true },
  } as Model<"openai-responses">;
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
  resetCommandQueueStateForTest();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  setDiagnosticsEnabledForProcess(false);
});

describe("automatic model fallback recovery at real HTTP", () => {
  it.for(["success", "expiry"] as const)(
    "preserves the fallback allowance through %s",
    async (terminal, { signal }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(OWNER_START_MS);
      setDiagnosticsEnabledForProcess(true);
      const fixture = await createResponsesFallbackFixture(signal);
      const ref = {
        runId: "fallback-" + terminal,
        sessionId: "fallback-session-" + terminal,
        sessionKey: "agent:main:fallback-" + terminal,
      };
      const owner = createDiagnosticEmbeddedRunOwner(ref);
      startDiagnosticRunActivityTracking();
      markDiagnosticEmbeddedRunStarted({ ...ref, owner });
      const controller = new AbortController();
      const activeEntered = createDeferred();
      const releaseActive = createDeferred();
      const streamingStarted = createDeferred();
      const context: Context = {
        messages: [{ role: "user", content: "Return a short synthetic response.", timestamp: 1 }],
      };
      let callSequence = 0;
      let chainSettled = false;
      const handle = {
        runId: ref.runId,
        diagnosticOwner: owner,
        closeDiagnostics: () => closeDiagnosticEmbeddedRunOwner(owner),
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(() => {
          controller.abort(new Error("diagnostic owner cancellation"));
          releaseActive.resolve();
        }),
      };
      const activeRun = enqueueCommandInLane(
        resolveEmbeddedSessionLane(ref.sessionKey),
        async () => {
          setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
          activeEntered.resolve();
          try {
            await releaseActive.promise;
            await chain;
            await waitForDiagnosticEventsDrained();
          } finally {
            clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
          }
        },
      );
      let chain:
        | Promise<{
            result?: Awaited<ReturnType<typeof runWithModelFallback<FixtureOutcome>>>;
            error?: unknown;
          }>
        | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            activeEntered.promise,
            activeRun,
            "owner settled before registration",
          ),
          signal,
        );
        chain = runWithModelFallback<FixtureOutcome>({
          cfg: undefined,
          provider: "synthetic-primary",
          model: "first",
          fallbacksOverride: ["synthetic-primary/retry", "ollama/local-response"],
          requestedRouteResolution: "resolved",
          skipAuthProfileRuntime: true,
          runId: ref.runId,
          sessionId: ref.sessionId,
          sessionKey: ref.sessionKey,
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
          await withinTest(
            awaitGateBeforeSettlement(
              fixture.received[index]!,
              chain,
              "chain settled before failed HTTP request",
            ),
            signal,
          );
          await waitForDiagnosticEventsDrained();
          vi.setSystemTime(OWNER_START_MS + (index + 1) * REQUEST_TIMEOUT_MS);
          fixture.failRequest(index);
        }
        await withinTest(
          awaitGateBeforeSettlement(
            fixture.received[2]!,
            chain,
            "chain settled before fallback HTTP request",
          ),
          signal,
        );
        expect(fixture.requests.map((request) => request.model)).toEqual([
          "first",
          "retry",
          "local-response",
        ]);
        fixture.startFallbackStream();
        await withinTest(
          awaitGateBeforeSettlement(
            streamingStarted.promise,
            chain,
            "fallback settled before streamed start",
          ),
          signal,
        );
        await waitForDiagnosticEventsDrained();
        const fallbackStartedAt = OWNER_START_MS + 2 * REQUEST_TIMEOUT_MS;
        vi.setSystemTime(fallbackStartedAt + 250);
        const activity = getDiagnosticSessionActivitySnapshot(ref);
        expect(activity.repeatedRequestNoProgressAgeMs).toBe(REQUEST_TIMEOUT_MS + 250);
        expect(activity.lastProgressReason).toBe("model_call:stream_progress");
        expect(isRepeatedModelRequestStalled(activity, STUCK_ABORT_MS)).toBe(false);
        expect(activity.activeModelCallRecoveryDeadlineAtMs).toBe(
          fallbackStartedAt + REQUEST_TIMEOUT_MS,
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
        const recover = () =>
          recoverStuckDiagnosticSession({
            sessionKey: ref.sessionKey,
            ageMs: Date.now() - OWNER_START_MS,
            queueDepth: 1,
            allowActiveAbort: true,
            repeatedRequestNoProgressAbortMs: STUCK_ABORT_MS,
          });
        expect(await recover()).toMatchObject({ status: "skipped", reason: "active_embedded_run" });
        expect(handle.abort).not.toHaveBeenCalled();
        expect(chainSettled).toBe(false);

        if (terminal === "success") {
          fixture.completeFallbackStream();
          const settled = await withinTest(chain, signal);
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
          expect(
            isRepeatedModelRequestStalled(
              getDiagnosticSessionActivitySnapshot(ref),
              STUCK_ABORT_MS,
            ),
          ).toBe(true);
          expect(await withinTest(recover(), signal)).toMatchObject({
            status: "aborted",
            action: "abort_embedded_run",
          });
          expect(handle.abort).toHaveBeenCalledOnce();
          expect((await withinTest(chain, signal)).error).toBeDefined();
        }
        expect(fixture.requests).toHaveLength(3);
      } finally {
        controller.abort(new Error("test cleanup"));
        releaseActive.resolve();
        try {
          if (chain) {
            await withinTest(chain, signal);
          }
          await withinTest(activeRun, signal);
        } finally {
          clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
          closeDiagnosticEmbeddedRunOwner(owner);
          await fixture.close();
        }
      }
    },
  );
});

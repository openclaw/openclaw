import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import { createAssistantMessageEventStream, type StreamFunction } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "./agent-message-fixtures.js";
import { createLiveModelCompletion } from "./live-model-completion.js";
import { makeProviderModelFixture } from "./provider-model-fixture.js";

const { completeOkWithRetry } = createLiveModelCompletion({
  getConfig: () => undefined,
  heartbeatMs: 30_000,
});

describe("live completion abort classification", () => {
  const api = "live-completion-abort-test";
  const model = makeProviderModelFixture({
    api,
    provider: api,
    id: "test-model",
    baseUrl: "https://example.invalid",
  });
  const stream = vi.fn<StreamFunction>();

  beforeEach(() => {
    vi.useFakeTimers();
    stream.mockReset();
    defaultApiRegistry.registerApiProvider({ api, stream, streamSimple: stream }, api);
  });

  afterEach(() => {
    defaultApiRegistry.unregisterApiProviders(api);
    vi.useRealTimers();
  });

  it.each([undefined, "transport cancelled at deadline"])(
    "rejects a transport that resolves aborted at its deadline (%s) without retrying",
    async (errorMessage) => {
      const started = Promise.withResolvers<void>();
      stream.mockImplementation((_model, _context, options) => {
        const output = createAssistantMessageEventStream();
        options?.signal?.addEventListener(
          "abort",
          () => {
            output.push({
              type: "error",
              reason: "aborted",
              error: makeAgentAssistantMessage({
                content: [],
                stopReason: "aborted",
                errorMessage,
              }),
            });
          },
          { once: true },
        );
        started.resolve();
        return output;
      });
      const completion = completeOkWithRetry({
        model,
        apiKey: "synthetic-key",
        timeoutMs: 1_000,
        progressLabel: "abort regression",
      });
      await Promise.all([
        expect(completion).rejects.toThrow(errorMessage ?? "model call timed out after 1000ms"),
        (async () => {
          await started.promise;
          // Settle a wrongly retried request too, so red reports the result, not a hang.
          await vi.advanceTimersByTimeAsync(2_000);
        })(),
      ]);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])(
    "preserves successful completion with token-length retry=%s",
    async (retry) => {
      const response = makeAgentAssistantMessage({ content: [{ type: "text", text: "ok" }] });
      stream.mockImplementation((_model, _context, options) => {
        const output = createAssistantMessageEventStream();
        const message =
          retry && options?.maxTokens === 64
            ? makeAgentAssistantMessage({ content: [], stopReason: "length" })
            : response;
        output.end(message);
        return output;
      });
      await expect(
        completeOkWithRetry({
          model,
          apiKey: "synthetic-key",
          timeoutMs: 1_000,
          progressLabel: "success regression",
        }),
      ).resolves.toEqual({ res: response, text: "ok" });
      expect(stream.mock.calls.map((call) => call[2]?.maxTokens)).toEqual(retry ? [64, 256] : [64]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

// ChatGPT Responses provider tests cover stream handling and timeout behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";
import {
  extractOpenAICodexAccountId,
  resetOpenAICodexWebSocketDebugStats,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

// Mirror the (non-exported) bounded-error-body constants in
// openai-chatgpt-responses.ts so the assertions stay in lockstep with the source.
const CODEX_ERROR_BODY_TEST_MAX_BYTES = 8 * 1024;
const CODEX_ERROR_BODY_TEST_IDLE_MS = 10_000;

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function stubTimeoutSignal(timeoutMs: number): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
    expect(actualTimeoutMs).toBe(timeoutMs);
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort(new DOMException("timed out", "TimeoutError"));
    });
    return controller.signal;
  });
}

function stubHangingFetch(timeoutMs: number): void {
  stubTimeoutSignal(timeoutMs);

  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }

          const abort = () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("aborted", "AbortError"),
            );
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        }),
    ),
  );
}

describe("extractOpenAICodexAccountId", () => {
  it("decodes URL-safe base64 JWT payloads", () => {
    const accessToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "w_ébé_1fzcswWN6Pi5zL",
      },
    });
    expect(accessToken.split(".")[1]).toContain("_");

    expect(extractOpenAICodexAccountId(accessToken)).toBe("w_ébé_1fzcswWN6Pi5zL");
  });

  it("rejects tokens without a Codex account id", () => {
    expect(() => extractOpenAICodexAccountId(createJwt({}))).toThrow(
      "Failed to extract accountId from token",
    );
  });
});

describe("streamOpenAICodexResponses transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetOpenAICodexWebSocketDebugStats();
  });

  const model = {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-chatgpt-responses",
    provider: "openai",
    baseUrl: "https://chatgpt.test/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
  } satisfies Model<"openai-chatgpt-responses">;

  const context = {
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  } satisfies Context;

  it("does not fall back to SSE when websocket transport is explicit", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not run");
    });
    vi.stubGlobal("fetch", fetchMock);
    class FailingWebSocket {
      constructor() {
        throw new Error("websocket connect failed");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      sessionId: "session-explicit-websocket",
      transport: "websocket",
    });

    const result = await stream.result();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("websocket connect failed");
  });

  it("honors timeoutMs for explicit SSE transport requests", async () => {
    stubHangingFetch(5);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      timeoutMs: 5,
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Request timed out after 5ms");
  });

  it("does not replay Responses item ids for store-disabled ChatGPT requests", async () => {
    let capturedPayload:
      | {
          store?: unknown;
          input?: Array<Record<string, unknown>>;
        }
      | undefined;
    const stream = streamOpenAICodexResponses(
      model,
      {
        messages: [
          {
            role: "assistant",
            api: "openai-chatgpt-responses",
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "lookup",
                arguments: {},
              },
            ],
          },
        ],
      },
      {
        apiKey: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-1",
          },
        }),
        transport: "sse",
        onPayload: (payload) => {
          capturedPayload = payload as typeof capturedPayload;
          throw new Error("stop after payload");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("stop after payload");
    expect(capturedPayload?.store).toBe(false);
    const reasoningItem = capturedPayload?.input?.find((item) => item.type === "reasoning");
    expect(reasoningItem).toMatchObject({
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem).not.toHaveProperty("id");
    const messageItem = capturedPayload?.input?.find((item) => item.type === "message");
    expect(messageItem).toMatchObject({
      type: "message",
      phase: "commentary",
    });
    expect(messageItem).not.toHaveProperty("id");
    const functionCall = capturedPayload?.input?.find((item) => item.type === "function_call");
    expect(functionCall).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall).not.toHaveProperty("id");
  });

  it("omits ChatGPT tool controls when every tool schema is unreadable", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const stream = streamOpenAICodexResponses(
      model,
      {
        ...context,
        tools: [
          {
            name: "broken",
            description: "Broken tool.",
            get parameters(): never {
              throw new Error("parameters exploded");
            },
          },
        ],
      },
      {
        apiKey: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-1",
          },
        }),
        transport: "sse",
        onPayload: (payload) => {
          capturedPayload = payload as Record<string, unknown>;
          throw new Error("stop after payload");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload).not.toHaveProperty("tools");
    expect(capturedPayload).not.toHaveProperty("tool_choice");
    expect(capturedPayload).not.toHaveProperty("parallel_tool_calls");
  });

  it("does not reread an unreadable ChatGPT tool inventory length", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const tools = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const stream = streamOpenAICodexResponses(model, { ...context, tools } as never, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      transport: "sse",
      onPayload: (payload) => {
        capturedPayload = payload as Record<string, unknown>;
        throw new Error("stop after payload");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload).not.toHaveProperty("tools");
    expect(capturedPayload).not.toHaveProperty("tool_choice");
    expect(capturedPayload).not.toHaveProperty("parallel_tool_calls");
  });

  it("caps oversized timeoutMs before creating request abort signals", async () => {
    stubHangingFetch(MAX_TIMER_TIMEOUT_MS);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      timeoutMs: Number.MAX_SAFE_INTEGER,
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(`Request timed out after ${MAX_TIMER_TIMEOUT_MS}ms`);
  });

  it("honors timeoutMs for default websocket transport requests", async () => {
    stubTimeoutSignal(5);
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not run before websocket timeout");
    });
    class HangingWebSocket {
      send = vi.fn();
      close = vi.fn();
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", HangingWebSocket);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      timeoutMs: 5,
    });

    const result = await stream.result();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Request timed out after 5ms");
  });

  it("does not send websocket payload after timeout fires during connect", async () => {
    let timeoutController: AbortController | undefined;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
      expect(actualTimeoutMs).toBe(5);
      timeoutController = new AbortController();
      return timeoutController.signal;
    });
    const sendMock = vi.fn();
    class OpeningThenTimedOutWebSocket {
      send = sendMock;
      close = vi.fn();
      addEventListener(type: string, listener: (event: unknown) => void): void {
        if (type === "open") {
          queueMicrotask(() => {
            listener({});
            timeoutController?.abort(new DOMException("timed out", "TimeoutError"));
          });
        }
      }
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", OpeningThenTimedOutWebSocket);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      timeoutMs: 5,
    });

    const result = await stream.result();

    expect(sendMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Request timed out after 5ms");
  });

  it("prefers promptCacheKey over sessionId for request cache affinity", async () => {
    let payload: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("usage limit: stop after payload");
      }),
    );

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      sessionId: "run-session",
      promptCacheKey: "stable-cache-key",
      transport: "sse",
      onPayload: (nextPayload) => {
        payload = nextPayload;
      },
    });

    await stream.result();

    expect(payload).toMatchObject({ prompt_cache_key: "stable-cache-key" });
  });

  it.each(["1.5", "0x10"])(
    "ignores invalid Retry-After header delay values: %s",
    async (retryAfter) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": retryAfter },
          }),
        )
        .mockRejectedValueOnce(new Error("usage limit: stop after retry delay"));
      vi.stubGlobal("fetch", fetchMock);
      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback: TimerHandler) => {
          if (typeof callback === "function") {
            callback();
          }
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      const stream = streamOpenAICodexResponses(model, context, {
        apiKey: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-1",
          },
        }),
        transport: "sse",
      });

      const result = await stream.result();

      expect(result.stopReason).toBe("error");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    },
  );

  it("caps oversized Retry-After delays before sleeping", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": String(Number.MAX_SAFE_INTEGER) },
        }),
      )
      .mockRejectedValueOnce(new Error("usage limit: stop after retry delay"));
    vi.stubGlobal("fetch", fetchMock);
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === "function") {
          callback();
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("bounds oversized streamed error responses without buffering the full body", async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode("E".repeat(64 * 1024));
    let maxBytesPulledPerResponse = 0;
    let cancelCount = 0;
    // Each attempt gets a fresh, oversized stream. The bounded reader caps the
    // body at 8 KiB and cancels the stream, so a single 64 KiB chunk is pulled
    // at most once per response instead of being drained to multiple megabytes.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      let bytesPulled = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            bytesPulled += chunk.byteLength;
            maxBytesPulledPerResponse = Math.max(maxBytesPulledPerResponse, bytesPulled);
            controller.enqueue(chunk);
          },
          cancel() {
            cancelCount += 1;
          },
        }),
        { status: 400, statusText: "Bad Request" },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    // Collapse the short inter-attempt backoff sleeps (<= 4s) without disturbing
    // the bounded reader's 10s idle-timeout guard, which must keep real timing.
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof callback === "function" && (delay ?? 0) < CODEX_ERROR_BODY_TEST_IDLE_MS) {
        callback(...args);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, delay, ...(args as []));
    }) as typeof setTimeout);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    // The error message is collapsed to the byte/char cap (8 KiB / 400 chars),
    // never the full multi-megabyte body that an unbounded read() would buffer.
    expect(result.errorMessage).toBe(`${"E".repeat(400)}…`);
    // Each attempt cancels its stream once the cap is hit instead of draining it,
    // so only a tiny, bounded prefix is ever held in memory per response. A
    // ReadableStream may pre-pull one extra chunk for backpressure, so allow a
    // small slack; the body itself is effectively unbounded (chunks keep coming
    // until cancelled), and without the cap this would balloon without limit.
    expect(cancelCount).toBeGreaterThanOrEqual(1);
    expect(maxBytesPulledPerResponse).toBeLessThanOrEqual(
      CODEX_ERROR_BODY_TEST_MAX_BYTES + chunk.byteLength * 2,
    );
  });

  it("still surfaces the friendly message from a normal-sized JSON error body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "usage_limit_reached",
            message: "You are out of credits.",
            plan_type: "Plus",
          },
        }),
        // 400 is non-retryable, so the very first attempt reaches parseErrorResponse.
        { status: 400, statusText: "Bad Request" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.errorMessage).toContain("You have hit your ChatGPT usage limit (plus plan)");
  });
});

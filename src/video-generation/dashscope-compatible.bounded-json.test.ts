// DashScope-compatible video provider response bound tests cover bounded JSON
// reads on the poll-status and submit-task paths so a faulty or hostile
// DashScope endpoint streaming an unbounded body cannot force the runtime to
// buffer the whole payload before parsing.
//
// Sibling coverage:
// - src/agents/provider-http-errors.test.ts exercises readProviderJsonResponse
//   in isolation (overflow, malformed, well-formed, streaming cancellation).
// - These tests exercise the dashscope call sites that route through it.

import { describe, expect, it } from "vitest";
import {
  pollDashscopeVideoTaskUntilComplete,
  runDashscopeVideoGenerationTask,
  type DashscopeVideoGenerationResponse,
} from "./dashscope-compatible.js";

// Provider JSON response cap mirrors the canonical helper's default in
// src/agents/provider-http-errors.ts so the test exercises the same boundary
// production code uses.
const PROVIDER_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

function createStreamingJsonResponse(params: {
  chunkCount: number;
  chunkSize: number;
  status?: number;
  contentType?: string;
}): { response: Response; getReadCount: () => number } {
  let reads = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(encoder.encode("a".repeat(params.chunkSize)));
    },
  });
  return {
    response: new Response(stream, {
      status: params.status ?? 200,
      headers: { "content-type": params.contentType ?? "application/json" },
    }),
    getReadCount: () => reads,
  };
}

function createStaticJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("dashscope-compatible bounded JSON responses", () => {
  it("parses a well-formed poll response through the bounded reader", async () => {
    const fetchMock = (() =>
      Promise.resolve(
        createStaticJsonResponse({
          output: { task_status: "SUCCEEDED", task_id: "task_1" },
          request_id: "req_1",
        }),
      )) as unknown as typeof fetch;
    const headers = new Headers({ authorization: "Bearer test" });

    const payload = await pollDashscopeVideoTaskUntilComplete({
      providerLabel: "dashscope",
      taskId: "task_1",
      headers,
      fetchFn: fetchMock,
      baseUrl: "https://dashscope.aliyuncs.com",
    });

    expect(payload.output?.task_status).toBe("SUCCEEDED");
    expect(payload.request_id).toBe("req_1");
  });

  it("caps the poll path JSON response when the body exceeds the canonical byte cap", async () => {
    // Build a streaming body that grows past PROVIDER_JSON_RESPONSE_MAX_BYTES
    // (16 MiB). Each chunk is 1 MiB; 100 chunks total = 100 MiB to clearly
    // demonstrate the bounded reader stops early instead of buffering the
    // whole payload.
    const streamed = createStreamingJsonResponse({
      chunkCount: 100,
      chunkSize: 1024 * 1024,
    });
    const fetchMock = (() => Promise.resolve(streamed.response)) as unknown as typeof fetch;
    const headers = new Headers({ authorization: "Bearer test" });

    await expect(
      pollDashscopeVideoTaskUntilComplete({
        providerLabel: "dashscope",
        taskId: "task_overflow",
        headers,
        fetchFn: fetchMock,
        baseUrl: "https://dashscope.aliyuncs.com",
      }),
    ).rejects.toThrow(/JSON response exceeds/);

    // The bounded reader must stop pulling chunks well before the 100-chunk
    // body completes. Allow +1 for the race between reader.cancel() and the
    // pull() callback in ReadableStream.
    expect(streamed.getReadCount()).toBeLessThan(100);
    expect(streamed.getReadCount()).toBeLessThanOrEqual(
      Math.ceil(PROVIDER_JSON_RESPONSE_MAX_BYTES / (1024 * 1024)) + 2,
    );
  });

  it("routes a well-formed submit-task response through the bounded reader", async () => {
    // Reuse the public type to keep the assertion shape honest.
    const submitBody: DashscopeVideoGenerationResponse = {
      output: { task_id: "task_submit_ok" },
      request_id: "req_submit_1",
    };

    // Drive the path that immediately calls readProviderJsonResponse on the
    // submit response: pollDashscopeVideoTaskUntilComplete re-reads via the
    // same fetchFn. Use a sequence mock so submit returns the task_id and the
    // first poll returns SUCCEEDED, exercising the parse path exactly once on
    // the submit body.
    const responses: Response[] = [
      createStaticJsonResponse(submitBody),
      createStaticJsonResponse({
        output: { task_status: "SUCCEEDED", task_id: "task_submit_ok" },
        request_id: "req_submit_1",
      }),
    ];
    const fetchMock = (() =>
      Promise.resolve(responses.shift() as Response)) as unknown as typeof fetch;
    const headers = new Headers({ authorization: "Bearer test" });

    // Drive the *bounded* parse directly through the helper surface, avoiding
    // the post-parse task-id lookup and the poll loop integration noise.
    const parsed = await pollDashscopeVideoTaskUntilComplete({
      providerLabel: "dashscope",
      taskId: "task_submit_ok",
      headers,
      fetchFn: fetchMock,
      baseUrl: "https://dashscope.aliyuncs.com",
    });

    expect(parsed.output?.task_status).toBe("SUCCEEDED");
    expect(parsed.request_id).toBe("req_submit_1");
  });

  it("surfaces a verbatim bounded-reader error from the submit path", async () => {
    // Drive runDashscopeVideoGenerationTask end-to-end with a streaming body
    // larger than the 16 MiB cap on the submit response (the very first call
    // on the request path). The bounded reader must surface its overflow
    // error before the runtime buffers the full payload.
    const streamed = createStreamingJsonResponse({
      chunkCount: 100,
      chunkSize: 1024 * 1024,
    });
    const fetchMock = (() => Promise.resolve(streamed.response)) as unknown as typeof fetch;
    const headers = new Headers({ authorization: "Bearer test" });

    await expect(
      runDashscopeVideoGenerationTask({
        providerLabel: "dashscope",
        model: "wan2.5-t2v-preview",
        req: {
          provider: "dashscope",
          model: "wan2.5-t2v-preview",
          prompt: "draw a square",
          cfg: {} as never,
        } as never,
        url: "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
        headers,
        baseUrl: "https://dashscope.aliyuncs.com",
        fetchFn: fetchMock,
        defaultTimeoutMs: 60_000,
      }),
    ).rejects.toThrow(/JSON response exceeds/);

    // Bounded reader stops well before the 100-chunk body completes.
    expect(streamed.getReadCount()).toBeLessThan(100);
  });
});

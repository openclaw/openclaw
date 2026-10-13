import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDashscopeVideoGenerationInput,
  buildDashscopeVideoGenerationParameters,
  downloadDashscopeGeneratedVideos,
  pollDashscopeVideoTaskUntilComplete,
  runDashscopeVideoGenerationTask,
} from "./dashscope-compatible.js";
import type { VideoGenerationRequest } from "./types.js";

function videoRequest(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return { provider: "qwen", model: "wan2.6-t2v", prompt: "video", cfg: {}, ...overrides };
}
function downloadVideo(
  fetchFn: typeof fetch,
  timeoutMs: Parameters<typeof downloadDashscopeGeneratedVideos>[0]["timeoutMs"] = 5_000,
  urls = ["https://example.com/video.mp4"],
) {
  return downloadDashscopeGeneratedVideos({
    providerLabel: "Alibaba Wan",
    urls,
    timeoutMs,
    fetchFn,
    maxBytes: 10 * 1024 * 1024,
  });
}
function runTask(
  fetchFn: typeof fetch,
  options: Partial<Parameters<typeof runDashscopeVideoGenerationTask>[0]> = {},
) {
  return runDashscopeVideoGenerationTask({
    providerLabel: "Qwen",
    model: "wan2.6-t2v",
    req: videoRequest(),
    url: "https://example.com/video-synthesis",
    headers: new Headers(),
    baseUrl: "https://example.com",
    fetchFn,
    ...options,
  });
}
function videoResponse(body = "mp4-bytes", contentType: string | undefined = "video/mp4") {
  return new Response(
    new TextEncoder().encode(body),
    contentType ? { headers: { "content-type": contentType } } : {},
  );
}

it("builds mode-specific image and reference inputs", () => {
  const cases: { req: Partial<VideoGenerationRequest>; expected: Record<string, unknown> }[] = [
    {
      req: {
        model: "wan2.6-i2v",
        prompt: "animate",
        inputImages: [{ url: "https://example.com/frame.png" }],
      },
      expected: { prompt: "animate", img_url: "https://example.com/frame.png" },
    },
    {
      req: {
        model: "wan2.6-r2v",
        prompt: "character1 waves",
        inputImages: [{ url: "https://example.com/character.png" }],
      },
      expected: {
        prompt: "character1 waves",
        reference_urls: ["https://example.com/character.png"],
      },
    },
    {
      req: {
        provider: "alibaba",
        model: "wan2.7-r2v",
        prompt: "Image 1 greets Video 1",
        inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        inputVideos: [{ url: "https://example.com/action.mp4", role: "reference_video" }],
      },
      expected: {
        prompt: "Image 1 greets Video 1",
        media: [
          { type: "reference_image", url: "data:image/png;base64,cG5nLWJ5dGVz" },
          { type: "reference_video", url: "https://example.com/action.mp4" },
        ],
      },
    },
  ];
  for (const { req, expected } of cases) {
    expect(
      buildDashscopeVideoGenerationInput({ providerLabel: "Qwen", req: videoRequest(req) }),
    ).toEqual(expected);
  }
});

it.each([
  {
    name: "Wan 2.6 text-to-video",
    req: videoRequest({ resolution: "720P", aspectRatio: "9:16", audio: false }),
    expected: { size: "720*1280", audio: false },
  },
  {
    name: "Wan 2.6 image-to-video",
    req: videoRequest({
      model: "wan2.6-i2v",
      resolution: "1080P",
      inputImages: [{ url: "https://example.com/frame.png" }],
      audio: true,
    }),
    expected: { resolution: "1080P", audio: true },
  },
  {
    name: "Wan 2.7 reference-to-video",
    req: videoRequest({
      provider: "alibaba",
      model: "wan2.7-r2v",
      size: "1920x1080",
      inputVideos: [{ url: "https://example.com/reference.mp4" }],
      audio: false,
    }),
    expected: { resolution: "1080P", ratio: "16:9" },
  },
])("builds documented $name parameters", ({ req, expected }) => {
  expect(buildDashscopeVideoGenerationParameters(req)).toEqual(expected);
});

it("returns only nonempty video bytes, preserving accepted content types", async () => {
  for (const [contentType, body] of [
    ["application/json", '{"error":"not a video"}'],
    ["audio/mp4", "audio-bytes"],
    ["video/mp4", ""],
  ]) {
    const fetchFn = vi.fn(async () => videoResponse(body, contentType));
    await expect(downloadVideo(fetchFn)).rejects.toThrow(
      "Alibaba Wan generated video download: malformed video response",
    );
    expect(fetchFn).toHaveBeenCalledOnce();
  }
  for (const contentType of ["VIDEO/MP4; codecs=avc1", "application/octet-stream", ""]) {
    const videos = await downloadVideo(vi.fn(async () => videoResponse("mp4-bytes", contentType)));
    expect(videos).toHaveLength(1);
    expect(videos[0]?.buffer).toBeInstanceOf(Buffer);
    expect(videos[0]).toMatchObject({
      buffer: Buffer.from("mp4-bytes"),
      fileName: "video-1.mp4",
      mimeType: contentType || "video/mp4",
    });
  }
});

it.each([false, true])(
  "releases unread invalid bodies with capture tee=%s",
  async (capture) => {
    const cancellationOrder: string[] = [];
    const cancelBody = vi.fn(async () => {
      cancellationOrder.push("cancel-started");
      await Promise.resolve();
      cancellationOrder.push("cancel-completed");
    });
    let captured: Response | undefined;
    const fetchFn = vi.fn(async () => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":"still streaming"}'));
          },
          cancel: cancelBody,
        }),
        { headers: { "content-type": "application/json" } },
      );
      // An unread debug clone holds the tee; rejection must not await its cancellation.
      if (capture) {
        captured = response.clone();
      }
      return response;
    });
    try {
      await expect(downloadVideo(fetchFn, capture ? 5_000 : 80)).rejects.toThrow(
        "Alibaba Wan generated video download: malformed video response",
      );
      if (!capture) {
        expect(cancelBody).toHaveBeenCalledOnce();
        expect(cancellationOrder).toEqual(["cancel-started", "cancel-completed"]);
      }
    } finally {
      void captured?.body?.cancel().catch(() => undefined);
    }
  },
  2_000,
);

it.each([
  { taskId: "expired-task", task_status: " UNKNOWN ", message: undefined, reason: "" },
  {
    taskId: "deleted-task",
    task_status: "UNKNOWN",
    message: "task was deleted",
    reason: ": task was deleted",
  },
])(
  "immediately rejects UNKNOWN $taskId with its provider reason",
  async ({ taskId, task_status, message, reason }) => {
    const fetchFn = vi.fn(async () => Response.json({ output: { task_status, message } }));
    await expect(
      pollDashscopeVideoTaskUntilComplete({
        providerLabel: "Qwen",
        taskId,
        headers: new Headers(),
        timeoutMs: 80,
        fetchFn,
        baseUrl: "https://example.com",
      }),
    ).rejects.toThrow(`Qwen video generation task ${taskId} is unknown or expired${reason}`);
    expect(fetchFn).toHaveBeenCalledOnce();
  },
);

it.each([
  {
    name: "buffer-backed reference video",
    model: "wan2.6-r2v",
    inputVideos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
    error: /remote http\(s\) URLs for reference videos/u,
  },
  {
    name: "data URI reference video",
    model: "wan2.7-r2v",
    inputVideos: [{ url: "data:video/mp4;base64,dmlkZW8=" }],
    error: /remote http\(s\) URLs for reference videos/u,
  },
  ...["wan2.6-i2v", "wan2.7-r2v"].map((model) => ({
    name: `oversized image for ${model}`,
    model,
    inputImages: [{ buffer: Buffer.alloc(20 * 1024 * 1024 + 1), mimeType: "image/png" }],
    error: /reference image exceeds the 20 MB limit/u,
  })),
  {
    name: "oversized inline data URI image",
    model: "wan2.6-i2v",
    inputImages: [
      { url: `data:image/png;base64,${Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64")}` },
    ],
    error: /reference image exceeds the 20 MB limit/u,
  },
  {
    name: "unknown i2v sibling",
    model: "wan2.5-t2v-preview",
    inputImages: [{ url: "https://example.com/image.png" }],
    error: /text-to-video.*does not accept reference media/u,
  },
  {
    name: "local image on Wan 2.6 reference-to-video",
    model: "wan2.6-r2v",
    inputImages: [{ buffer: Buffer.from("png-bytes") }],
    error: /requires remote http\(s\) URLs for reference images/u,
  },
  {
    name: "multiple images with a text-to-video model",
    model: "wan2.6-t2v",
    inputImages: [{ url: "https://example.com/1.png" }, { url: "https://example.com/2.png" }],
    error: /text-to-video.*does not accept reference media/u,
  },
])("rejects $name before submission", async ({ name: _name, error, ...request }) => {
  const fetchFn = vi.fn<typeof fetch>();
  await expect(
    runTask(fetchFn, { model: request.model, req: videoRequest(request) }),
  ).rejects.toThrow(error);
  expect(fetchFn).not.toHaveBeenCalled();
});

describe("DashScope operation deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function expectDeadline(
    operation: Promise<unknown>,
    ms: number,
    pattern = /timed out|budget exhausted/,
  ) {
    let settled: unknown;
    const completion = operation.then(
      (value) => {
        settled = value;
      },
      (error: unknown) => {
        settled = error;
      },
    );
    await vi.advanceTimersByTimeAsync(ms);
    expect(settled).toBeInstanceOf(Error);
    expect(String(settled)).toMatch(pattern);
    await completion;
  }

  it.each([false, true])(
    "aborts a stalled body without waiting for capture tee=%s",
    async (capture) => {
      let captured: Response | undefined;
      let signal: AbortSignal | undefined;
      const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        const response = new Response(
          new ReadableStream({
            start(controller) {
              if (capture) {
                controller.enqueue(new Uint8Array([1]));
              }
            },
          }),
          { headers: { "content-type": "video/mp4" } },
        );
        if (capture) {
          captured = response.clone();
        }
        return response;
      });
      try {
        const startedAt = Date.now();
        await expectDeadline(
          downloadVideo(fetchFn, 80),
          80,
          /Alibaba Wan generated video download timed out/,
        );
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(signal?.aborted).toBe(true);
        expect(fetchFn).toHaveBeenCalledOnce();
      } finally {
        void captured?.body?.cancel().catch(() => undefined);
      }
    },
  );

  it("fails closed before fetch when a function-valued remaining budget is exhausted", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const startedAt = Date.now();
    await expect(downloadVideo(fetchFn, () => 0)).rejects.toThrow("remaining budget exhausted");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("releases the guarded fetch when the remaining-budget resolver throws", async () => {
    const initialTimerCount = vi.getTimerCount();
    let requestSignal: AbortSignal | undefined;
    let abortedAtFetch: boolean | undefined;
    const cancelBody = vi.fn();
    const timeoutMs = vi
      .fn<() => number>()
      .mockReturnValueOnce(100)
      .mockImplementationOnce(() => {
        throw new Error("remaining-budget resolver failed");
      });
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      abortedAtFetch = requestSignal?.aborted;
      return new Response(new ReadableStream({ cancel: cancelBody }), {
        headers: { "content-type": "video/mp4" },
      });
    });
    await expect(downloadVideo(fetchFn, timeoutMs)).rejects.toThrow(
      "remaining-budget resolver failed",
    );
    expect(timeoutMs).toHaveBeenCalledTimes(2);
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(cancelBody.mock.calls[0]?.[0]).toMatchObject({
      message: "remaining-budget resolver failed",
    });
    expect(abortedAtFetch).toBe(false);
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(initialTimerCount);
  });

  it("releases the submission request timeout before polling the task", async () => {
    let submissionSignal: AbortSignal | undefined;
    let submissionReleasedBeforePoll: boolean | undefined;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = url instanceof Request ? url.url : String(url);
      if (requestUrl.includes("/video-synthesis")) {
        submissionSignal = init?.signal ?? undefined;
        return Response.json({ output: { task_id: "task-123" } });
      }
      if (requestUrl.includes("/tasks/task-123")) {
        submissionReleasedBeforePoll = submissionSignal?.aborted;
        return Response.json({
          output: { task_status: "SUCCEEDED", video_url: "https://example.com/result.mp4" },
        });
      }
      return videoResponse();
    });
    await runTask(fetchFn, { timeoutMs: 5_000 });
    expect(submissionReleasedBeforePoll).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["submit", "poll", "download", "submit-error", "poll-error", "download-error"])(
    "bounds a trickling %s body with the same operation deadline",
    async (stage) => {
      let timer: ReturnType<typeof setInterval>;
      const cancel = vi.fn(() => clearInterval(timer));
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setInterval(() => controller.enqueue(new TextEncoder().encode(" ")), 10);
          },
          cancel,
        }),
        {
          status: stage.endsWith("error") ? 503 : 200,
          headers: {
            "content-type": stage.startsWith("download") ? "video/mp4" : "application/json",
          },
        },
      );
      const signals: AbortSignal[] = [];
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.signal) {
          signals.push(init.signal);
        }
        const requestUrl = url instanceof Request ? url.url : String(url);
        if (requestUrl.includes("video-synthesis")) {
          return stage.startsWith("submit")
            ? response
            : Response.json({ output: { task_id: "deadline-task" } });
        }
        if (requestUrl.includes("/tasks/")) {
          return stage.startsWith("poll")
            ? response
            : Response.json({
                output: { task_status: "SUCCEEDED", video_url: "https://example.com/video.mp4" },
              });
        }
        return response;
      });
      try {
        await expectDeadline(runTask(fetchFn, { timeoutMs: 100 }), 100);
        expect(cancel).toHaveBeenCalledOnce();
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(fetchFn).toHaveBeenCalledTimes(
          stage.startsWith("submit") ? 1 : stage.startsWith("poll") ? 2 : 3,
        );
      } finally {
        void response.body?.cancel().catch(() => undefined);
      }
    },
  );

  it("does not reset a numeric budget between sequential downloads or after headers", async () => {
    const fetchFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 40);
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("video"));
              controller.close();
            }, 20);
          },
        }),
        { headers: { "content-type": "video/mp4" } },
      );
    });
    await expectDeadline(
      downloadVideo(fetchFn, 100, ["https://example.com/1.mp4", "https://example.com/2.mp4"]),
      101,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503])(
    "does not let HTTP %s retry backoff outlive the remaining budget",
    async (status) => {
      const fetchFn = vi.fn(async () => new Response("busy", { status }));
      await expectDeadline(downloadVideo(fetchFn, 100), 100, /timed out/);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("still retries a transient response and returns complete video bytes within budget", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(videoResponse("video"));
    const operation = downloadVideo(fetchFn, 500);
    await vi.advanceTimersByTimeAsync(250);
    expect((await operation)[0]?.buffer?.toString()).toBe("video");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("charges submission and poll waits to the default operation budget", async () => {
    const fetchFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      return Response.json(
        fetchFn.mock.calls.length === 1
          ? { output: { task_id: "pending" } }
          : { output: { task_status: "PENDING" } },
      );
    });
    await expectDeadline(runTask(fetchFn, { defaultTimeoutMs: 100 }), 100, /timed out after 100ms/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// DashScope-compatible lifecycle, task status, and generated-video regressions.
import { describe, expect, it, vi } from "vitest";
import {
  DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
  buildDashscopeVideoGenerationInput,
  buildDashscopeVideoGenerationParameters,
  downloadDashscopeGeneratedVideos,
  pollDashscopeVideoTaskUntilComplete,
  runDashscopeVideoGenerationTask,
} from "./dashscope-compatible.js";
import type { VideoGenerationRequest } from "./types.js";

const invalidGeneratedVideos = [
  { name: "JSON error", contentType: "application/json", body: '{"error":"not a video"}' },
  { name: "audio", contentType: "audio/mp4", body: "audio-bytes" },
  { name: "empty video", contentType: "video/mp4", body: "" },
] as const;

function videoRequest(overrides: Partial<VideoGenerationRequest>): VideoGenerationRequest {
  return { provider: "qwen", model: "wan2.6-t2v", prompt: "video", cfg: {}, ...overrides };
}

function downloadVideo(
  fetchFn: typeof fetch,
  timeoutMs: Parameters<typeof downloadDashscopeGeneratedVideos>[0]["timeoutMs"] = 5_000,
) {
  return downloadDashscopeGeneratedVideos({
    providerLabel: "Alibaba Wan",
    urls: ["https://example.com/video.mp4"],
    timeoutMs,
    fetchFn,
    maxBytes: 10 * 1024 * 1024,
  });
}

function neverChunkingVideoResponse(): Response {
  return new Response(
    new ReadableStream({
      start() {
        // Headers only — never enqueue so chunk idle must win.
      },
    }),
    {
      status: 200,
      headers: { "content-type": "video/mp4" },
    },
  );
}

describe("DashScope Wan request contracts", () => {
  it("advertises only the modes supported by each bundled Wan model", () => {
    expect(DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.6-t2v"]?.modes).toEqual(["generate"]);
    expect(
      DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.6-t2v"]?.capabilities?.generate
        ?.supportsAspectRatio,
    ).toBe(true);
    expect(DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.6-i2v"]?.modes).toEqual(["imageToVideo"]);
    expect(DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.6-r2v"]?.modes).toEqual([
      "imageToVideo",
      "videoToVideo",
    ]);
    expect(
      DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.7-r2v"]?.capabilities?.videoToVideo?.supportsAudio,
    ).toBe(false);
    expect(
      DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL["wan2.7-r2v"]?.capabilities?.videoToVideo
        ?.supportsAspectRatio,
    ).toBe(true);
  });

  it("builds mode-specific image and reference inputs", () => {
    expect(
      buildDashscopeVideoGenerationInput({
        providerLabel: "Qwen",
        req: videoRequest({
          model: "wan2.6-i2v",
          prompt: "animate",
          inputImages: [{ url: "https://example.com/frame.png" }],
        }),
      }),
    ).toEqual({ prompt: "animate", img_url: "https://example.com/frame.png" });

    expect(
      buildDashscopeVideoGenerationInput({
        providerLabel: "Qwen",
        req: videoRequest({
          model: "wan2.6-r2v",
          prompt: "character1 waves",
          inputImages: [{ url: "https://example.com/character.png" }],
        }),
      }),
    ).toEqual({
      prompt: "character1 waves",
      reference_urls: ["https://example.com/character.png"],
    });

    expect(
      buildDashscopeVideoGenerationInput({
        providerLabel: "Alibaba Wan",
        req: videoRequest({
          provider: "alibaba",
          model: "wan2.7-r2v",
          prompt: "Image 1 greets Video 1",
          inputImages: [{ url: "https://example.com/character.png" }],
          inputVideos: [{ url: "https://example.com/action.mp4", role: "reference_video" }],
        }),
      }),
    ).toEqual({
      prompt: "Image 1 greets Video 1",
      media: [
        { type: "reference_image", url: "https://example.com/character.png" },
        { type: "reference_video", url: "https://example.com/action.mp4" },
      ],
    });
  });

  it("rejects model and reference mode mismatches before submission", () => {
    expect(() =>
      buildDashscopeVideoGenerationInput({
        providerLabel: "Qwen",
        req: videoRequest({
          prompt: "animate",
          inputImages: [{ url: "https://example.com/frame.png" }],
        }),
      }),
    ).toThrow(/text-to-video.*does not accept reference media/u);
  });

  it.each([
    {
      name: "Wan 2.6 text-to-video",
      req: videoRequest({
        resolution: "720P",
        aspectRatio: "9:16",
        audio: false,
      }),
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
});

describe("downloadDashscopeGeneratedVideos", () => {
  it.each(invalidGeneratedVideos)(
    "rejects $name responses instead of returning a video",
    async (invalid) => {
      const fetchFn = vi.fn(
        async () =>
          new Response(invalid.body, {
            status: 200,
            headers: { "content-type": invalid.contentType },
          }),
      );

      await expect(downloadVideo(fetchFn)).rejects.toThrow(
        "Alibaba Wan generated video download: malformed video response",
      );

      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );

  it("cancels unread invalid video bodies before releasing them", async () => {
    const cancellationOrder: string[] = [];
    const cancelBody = vi.fn(async () => {
      cancellationOrder.push("cancel-started");
      await Promise.resolve();
      cancellationOrder.push("cancel-completed");
    });
    const fetchFn = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"error":"still streaming"}'));
            },
            cancel: cancelBody,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    await expect(downloadVideo(fetchFn, 80)).rejects.toThrow(
      "Alibaba Wan generated video download: malformed video response",
    );

    expect(cancelBody).toHaveBeenCalledOnce();
    expect(cancellationOrder).toEqual(["cancel-started", "cancel-completed"]);
  });

  it.each([
    { contentType: "VIDEO/MP4; codecs=avc1", expectedMimeType: "VIDEO/MP4; codecs=avc1" },
    { contentType: "application/octet-stream", expectedMimeType: "application/octet-stream" },
    { contentType: undefined, expectedMimeType: "video/mp4" },
  ])(
    "preserves valid generated video content type $contentType",
    async ({ contentType, expectedMimeType }) => {
      const fetchFn = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("mp4-bytes"));
                controller.close();
              },
            }),
            {
              status: 200,
              ...(contentType ? { headers: { "content-type": contentType } } : {}),
            },
          ),
      );

      const videos = await downloadVideo(fetchFn);

      expect(videos).toHaveLength(1);
      expect(videos[0]?.buffer).toBeInstanceOf(Buffer);
      expect(videos[0]).toMatchObject({
        buffer: Buffer.from("mp4-bytes"),
        fileName: "video-1.mp4",
        mimeType: expectedMimeType,
      });
    },
  );

  it("aborts a stalled generated video body at its operation deadline", async () => {
    const fetchFn = vi.fn(async () => neverChunkingVideoResponse());
    const timeoutMs = 80;
    const startedAt = Date.now();

    await expect(downloadVideo(fetchFn, timeoutMs)).rejects.toThrow(
      /Alibaba Wan generated video download timed out/,
    );

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 20);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed response while a debug-capture clone still holds the body tee", async () => {
    let captured: Response | undefined;
    const fetchFn = vi.fn(async () => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":"denied"'));
            // The body never ends, so only an explicit cancel can settle it.
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      // Debug capture keeps an unread clone; the tee leaves the source branch
      // pending, so awaiting the cancel of the rejected body would never settle.
      captured = response.clone();
      return response;
    });

    try {
      await expect(downloadVideo(fetchFn)).rejects.toThrow(
        "Alibaba Wan generated video download: malformed video response",
      );
    } finally {
      void captured?.body?.cancel().catch(() => undefined);
    }
  }, 2_000);

  it("fails closed before fetch when a function-valued remaining budget is exhausted", async () => {
    const fetchFn = vi.fn(async () => neverChunkingVideoResponse());
    const startedAt = Date.now();

    await expect(downloadVideo(fetchFn, () => 0)).rejects.toThrow("remaining budget exhausted");

    const elapsedMs = Date.now() - startedAt;
    // Should reject quickly (0ms budget), not wait for the 60s default.
    expect(elapsedMs).toBeLessThan(2_000);
    // Exhausted deadline is checked before fetch — no network I/O is initiated.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("releases the guarded fetch when the remaining-budget resolver throws", async () => {
    vi.useFakeTimers();
    try {
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
          status: 200,
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
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pollDashscopeVideoTaskUntilComplete", () => {
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
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify({ output: { task_status, message } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );

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
});

describe("runDashscopeVideoGenerationTask", () => {
  it("releases the submission request timeout before polling the task", async () => {
    vi.useFakeTimers();
    try {
      let submissionSignal: AbortSignal | undefined;
      let submissionReleasedBeforePoll: boolean | undefined;
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = url instanceof Request ? url.url : String(url);
        if (requestUrl.includes("/video-synthesis")) {
          submissionSignal = init?.signal ?? undefined;
          return new Response(JSON.stringify({ output: { task_id: "task-123" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (requestUrl.includes("/tasks/task-123")) {
          submissionReleasedBeforePoll = submissionSignal?.aborted;
          return new Response(
            JSON.stringify({
              output: { task_status: "SUCCEEDED", video_url: "https://example.com/result.mp4" },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(new TextEncoder().encode("mp4-bytes"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      });

      await runDashscopeVideoGenerationTask({
        providerLabel: "Qwen",
        model: "wan2.6-t2v",
        req: videoRequest({}),
        url: "https://example.com/video-synthesis",
        headers: new Headers(),
        baseUrl: "https://example.com",
        timeoutMs: 5_000,
        fetchFn: fetchFn as typeof fetch,
      });

      expect(submissionReleasedBeforePoll).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Exercise the owner functions with real Response streams. Frequent bytes must
// not refresh the total budget, and a completed header read must not reset it.
describe("DashScope operation deadline", () => {
  function streamingResponse(contentType: string, status = 200) {
    let timer: ReturnType<typeof setInterval>;
    const cancel = vi.fn(() => clearInterval(timer));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => controller.enqueue(new TextEncoder().encode(" ")), 10);
        },
        cancel,
      }),
      { status, headers: { "content-type": contentType } },
    );
    return { response, cancel };
  }

  it.each(["submit", "poll", "download", "submit-error", "poll-error", "download-error"])(
    "bounds a trickling %s body with the same operation deadline",
    async (stage) => {
      vi.useFakeTimers();
      const body = streamingResponse(
        stage.startsWith("download") ? "video/mp4" : "application/json",
        stage.endsWith("error") ? 503 : 200,
      );
      const signals: AbortSignal[] = [];
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.signal) {
          signals.push(init.signal);
        }
        const requestUrl = url instanceof Request ? url.url : String(url);
        if (requestUrl.includes("video-synthesis")) {
          if (stage.startsWith("submit")) {
            return body.response;
          }
          return Response.json({ output: { task_id: "deadline-task" } });
        }
        if (requestUrl.includes("/tasks/")) {
          if (stage.startsWith("poll")) {
            return body.response;
          }
          return Response.json({
            output: { task_status: "SUCCEEDED", video_url: "https://example.com/video.mp4" },
          });
        }
        return body.response;
      });
      try {
        let settled: unknown;
        const operation = runDashscopeVideoGenerationTask({
          providerLabel: "Qwen",
          model: "wan2.6-t2v",
          req: { provider: "qwen", model: "wan2.6-t2v", prompt: "synthetic", cfg: {} },
          url: "https://example.com/video-synthesis",
          headers: new Headers(),
          baseUrl: "https://example.com",
          timeoutMs: 100,
          fetchFn,
        }).then(
          (value) => {
            settled = value;
          },
          (error: unknown) => {
            settled = error;
          },
        );
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBeInstanceOf(Error);
        expect(String(settled)).toMatch(/timed out|budget exhausted/);
        await operation;
        expect(body.cancel).toHaveBeenCalledOnce();
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(fetchFn).toHaveBeenCalledTimes(
          stage.startsWith("submit") ? 1 : stage.startsWith("poll") ? 2 : 3,
        );
      } finally {
        void body.response.body?.cancel().catch(() => undefined);
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("does not reset a numeric budget between sequential downloads or after headers", async () => {
    vi.useFakeTimers();
    try {
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
      let settled: unknown;
      const operation = downloadDashscopeGeneratedVideos({
        providerLabel: "Qwen",
        urls: ["https://example.com/1.mp4", "https://example.com/2.mp4"],
        timeoutMs: 100,
        fetchFn,
        maxBytes: 1024,
      }).then(
        (value) => {
          settled = value;
        },
        (error: unknown) => {
          settled = error;
        },
      );
      await vi.advanceTimersByTimeAsync(101);
      expect(settled).toBeInstanceOf(Error);
      expect(String(settled)).toMatch(/timed out|budget exhausted/);
      await operation;
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("DashScope retry and release deadlines", () => {
  it.each([429, 503])(
    "does not let HTTP %s retry backoff outlive the remaining budget",
    async (status) => {
      vi.useFakeTimers();
      try {
        const fetchFn = vi.fn(async () => new Response("busy", { status }));
        let error: unknown;
        const operation = downloadDashscopeGeneratedVideos({
          providerLabel: "Qwen",
          urls: ["https://example.com/out.mp4"],
          timeoutMs: 100,
          fetchFn,
          maxBytes: 1024,
        }).catch((reason: unknown) => {
          error = reason;
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toMatch(/timed out/);
        await operation;
        expect(fetchFn).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("still retries a transient response and returns complete video bytes within budget", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(new Response("busy", { status: 503 }))
        .mockResolvedValueOnce(new Response("video", { headers: { "content-type": "video/mp4" } }));
      const operation = downloadDashscopeGeneratedVideos({
        providerLabel: "Qwen",
        urls: ["https://example.com/out.mp4"],
        timeoutMs: 500,
        fetchFn,
        maxBytes: 1024,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect((await operation)[0]?.buffer?.toString()).toBe("video");
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("charges submission and poll waits to the default operation budget", async () => {
    vi.useFakeTimers();
    try {
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
      let error: unknown;
      const operation = runDashscopeVideoGenerationTask({
        providerLabel: "Qwen",
        model: "wan2.6-t2v",
        req: { provider: "qwen", model: "wan2.6-t2v", prompt: "synthetic", cfg: {} },
        url: "https://example.com/video-synthesis",
        headers: new Headers(),
        baseUrl: "https://example.com",
        defaultTimeoutMs: 100,
        fetchFn,
      }).catch((reason: unknown) => {
        error = reason;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(String(error)).toMatch(/timed out after 100ms/);
      await operation;
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("releases an expired successful-body read without waiting for a capture tee", async () => {
    vi.useFakeTimers();
    let captured: Response | undefined;
    try {
      let signal: AbortSignal | undefined;
      const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        const response = new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
          { headers: { "content-type": "video/mp4" } },
        );
        captured = response.clone();
        return response;
      });
      let error: unknown;
      const operation = downloadDashscopeGeneratedVideos({
        providerLabel: "Qwen",
        urls: ["https://example.com/out.mp4"],
        timeoutMs: 100,
        fetchFn,
        maxBytes: 1024,
      }).catch((reason: unknown) => {
        error = reason;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(String(error)).toMatch(/timed out/);
      await operation;
      expect(signal?.aborted).toBe(true);
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally {
      void captured?.body?.cancel().catch(() => undefined);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

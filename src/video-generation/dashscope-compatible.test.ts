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

function streamFixture(
  source: UnderlyingSource<Uint8Array>,
  capture = false,
  contentType = "video/mp4",
  status = 200,
) {
  const response = new Response(new ReadableStream(source), {
    status,
    headers: { "content-type": contentType },
  });
  const captured = capture ? response.clone() : undefined;
  const requests: Array<{ signal?: AbortSignal | null; aborted?: boolean }> = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    requests.push({ signal: init?.signal, aborted: init?.signal?.aborted });
    return response;
  });
  return {
    response,
    fetchFn,
    requests,
    release() {
      // An unread debug clone holds the tee; never await its cancellation.
      void (captured ?? response).body?.cancel().catch(() => undefined);
    },
  };
}

type Stage = "submit" | "poll" | "download";
function taskFetch(
  responses: Partial<Record<Stage, Response>> = {},
  observe?: (stage: Stage, signal: AbortSignal | null | undefined) => void,
) {
  const signals: AbortSignal[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    const path = url instanceof Request ? url.url : String(url);
    const stage = path.includes("video-synthesis")
      ? "submit"
      : path.includes("/tasks/task-123")
        ? "poll"
        : "download";
    if (init?.signal) {
      signals.push(init.signal);
    }
    observe?.(stage, init?.signal);
    return (
      responses[stage] ??
      (stage === "download"
        ? videoResponse()
        : Response.json({
            output:
              stage === "submit"
                ? { task_id: "task-123" }
                : { task_status: "SUCCEEDED", video_url: videoUrl },
          }))
    );
  });
  return { fetchFn, signals };
}

it("rejects a duration that rounds to zero before submission", async () => {
  const fetchFn = vi.fn<typeof fetch>();
  await expect(runTask(fetchFn, { req: videoRequest({ durationSeconds: 0.4 }) })).rejects.toThrow(
    "durationSeconds must be a positive duration",
  );
  expect(fetchFn).not.toHaveBeenCalled();
});

const imageUrl = "https://example.com/frame.png";
const videoUrl = "https://example.com/video.mp4";
const remoteImage = { url: imageUrl };
const remoteVideo = { url: videoUrl };
const localImage = { buffer: Buffer.from("png-bytes"), mimeType: "image/png" };

it.each<[Partial<VideoGenerationRequest>, Record<string, unknown>]>([
  [{ model: "wan2.6-i2v", inputImages: [remoteImage] }, { img_url: imageUrl }],
  [{ model: "wan2.6-r2v", inputImages: [remoteImage] }, { reference_urls: [imageUrl] }],
  [
    {
      provider: "alibaba",
      model: "wan2.7-r2v",
      inputImages: [localImage],
      inputVideos: [{ ...remoteVideo, role: "reference_video" }],
    },
    {
      media: [
        { type: "reference_image", url: "data:image/png;base64,cG5nLWJ5dGVz" },
        { type: "reference_video", url: videoUrl },
      ],
    },
  ],
])("builds mode-specific inputs for %#", (req, expected) => {
  expect(
    buildDashscopeVideoGenerationInput({ providerLabel: "Qwen", req: videoRequest(req) }),
  ).toEqual({ prompt: "video", ...expected });
});

it.each<[string, Partial<VideoGenerationRequest>, Record<string, unknown>]>([
  [
    "wan2.6-t2v",
    { resolution: "720P", aspectRatio: "9:16", audio: false },
    { size: "720*1280", audio: false },
  ],
  ["wan2.6-i2v", { resolution: "1080P", audio: true }, { resolution: "1080P", audio: true }],
  ["wan2.7-r2v", { size: "1920x1080", audio: false }, { resolution: "1080P", ratio: "16:9" }],
])("builds %s parameters", (model, req, expected) => {
  expect(buildDashscopeVideoGenerationParameters(videoRequest({ model, ...req }))).toEqual(
    expected,
  );
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

async function expectRejectedRequest(req: Partial<VideoGenerationRequest>, error: RegExp) {
  const fetchFn = vi.fn<typeof fetch>();
  await expect(runTask(fetchFn, { model: req.model, req: videoRequest(req) })).rejects.toThrow(
    error,
  );
  expect(fetchFn).not.toHaveBeenCalled();
}

it.each([
  { model: "wan2.6-r2v", inputVideos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }] },
  { model: "wan2.7-r2v", inputVideos: [{ url: "data:video/mp4;base64,dmlkZW8=" }] },
])("rejects non-remote reference videos for $model", async (req) => {
  await expectRejectedRequest(req, /remote http\(s\) URLs for reference videos/u);
});

const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
it.each([
  { model: "wan2.6-i2v", inputImages: [{ buffer: oversized, mimeType: "image/png" }] },
  { model: "wan2.7-r2v", inputImages: [{ buffer: oversized, mimeType: "image/png" }] },
  {
    model: "wan2.6-i2v",
    inputImages: [{ url: `data:image/png;base64,${oversized.toString("base64")}` }],
  },
])("rejects oversized reference images for $model (%#)", async (req) => {
  await expectRejectedRequest(req, /reference image exceeds the 20 MB limit/u);
});

it.each([
  { model: "wan2.5-t2v-preview", inputImages: [remoteImage] },
  { model: "wan2.6-t2v", inputImages: [remoteImage, { url: "https://example.com/2.png" }] },
])("rejects reference media for $model", async (req) => {
  await expectRejectedRequest(req, /text-to-video.*does not accept reference media/u);
});

it("rejects local images on Wan 2.6 reference-to-video", async () => {
  await expectRejectedRequest(
    { model: "wan2.6-r2v", inputImages: [{ buffer: localImage.buffer }] },
    /requires remote http\(s\) URLs for reference images/u,
  );
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
    const record = (value: unknown) => {
      settled = value;
    };
    const completion = operation.then(record, record);
    await vi.advanceTimersByTimeAsync(ms);
    expect(settled).toBeInstanceOf(Error);
    expect(String(settled)).toMatch(pattern);
    await completion;
  }

  it.each([
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ])(
    "releases a streaming body (invalid=%s, capture tee=%s)",
    async (invalid, capture) => {
      const order: string[] = [];
      const cancel = vi.fn(async () => {
        order.push("cancel-started");
        await Promise.resolve();
        order.push("cancel-completed");
      });
      const fixture = streamFixture(
        {
          start(controller) {
            if (invalid || capture) {
              controller.enqueue(new TextEncoder().encode("streaming"));
            }
          },
          cancel: invalid ? cancel : undefined,
        },
        capture,
        invalid ? "application/json" : "video/mp4",
      );
      try {
        const startedAt = Date.now();
        const operation = downloadVideo(fixture.fetchFn, invalid && capture ? 5_000 : 80);
        if (invalid) {
          await expect(operation).rejects.toThrow(
            "Alibaba Wan generated video download: malformed video response",
          );
          if (!capture) {
            expect(cancel).toHaveBeenCalledOnce();
            expect(order).toEqual(["cancel-started", "cancel-completed"]);
          }
        } else {
          await expectDeadline(operation, 80, /Alibaba Wan generated video download timed out/);
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
          expect(Date.now() - startedAt).toBeLessThan(2_000);
          expect(fixture.requests[0]?.signal?.aborted).toBe(true);
          expect(fixture.fetchFn).toHaveBeenCalledOnce();
        }
      } finally {
        fixture.release();
      }
    },
    2_000,
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
    const cancelBody = vi.fn();
    const timeoutMs = vi
      .fn<() => number>()
      .mockReturnValueOnce(100)
      .mockImplementationOnce(() => {
        throw new Error("remaining-budget resolver failed");
      });
    const fixture = streamFixture({ cancel: cancelBody });
    await expect(downloadVideo(fixture.fetchFn, timeoutMs)).rejects.toThrow(
      "remaining-budget resolver failed",
    );
    expect(timeoutMs).toHaveBeenCalledTimes(2);
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(cancelBody.mock.calls[0]?.[0]).toMatchObject({
      message: "remaining-budget resolver failed",
    });
    expect(fixture.requests[0]).toMatchObject({ aborted: false, signal: { aborted: true } });
    expect(vi.getTimerCount()).toBe(initialTimerCount);
  });

  it("releases the submission request timeout before polling the task", async () => {
    let submissionSignal: AbortSignal | undefined;
    let submissionReleasedBeforePoll: boolean | undefined;
    const { fetchFn } = taskFetch({}, (stage, signal) => {
      if (stage === "submit") {
        submissionSignal = signal ?? undefined;
      }
      if (stage === "poll") {
        submissionReleasedBeforePoll = submissionSignal?.aborted;
      }
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
      const fixture = streamFixture(
        {
          start(controller) {
            timer = setInterval(() => controller.enqueue(new TextEncoder().encode(" ")), 10);
          },
          cancel,
        },
        false,
        stage.startsWith("download") ? "video/mp4" : "application/json",
        stage.endsWith("error") ? 503 : 200,
      );
      const key = stage.startsWith("submit")
        ? "submit"
        : stage.startsWith("poll")
          ? "poll"
          : "download";
      const { fetchFn, signals } = taskFetch({ [key]: fixture.response });
      try {
        await expectDeadline(runTask(fetchFn, { timeoutMs: 100 }), 100);
        expect(cancel).toHaveBeenCalledOnce();
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(fetchFn).toHaveBeenCalledTimes(
          stage.startsWith("submit") ? 1 : stage.startsWith("poll") ? 2 : 3,
        );
      } finally {
        fixture.release();
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

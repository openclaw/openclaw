import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDashscopeVideoGenerationInput as buildInput,
  buildDashscopeVideoGenerationParameters as buildParameters,
  downloadDashscopeGeneratedVideos as downloadVideos,
  pollDashscopeVideoTaskUntilComplete as pollTask,
  runDashscopeVideoGenerationTask as generateTask,
} from "./dashscope-compatible.js";
import type { VideoGenerationRequest as VideoRequest } from "./types.js";

function videoRequest(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return { provider: "qwen", model: "wan2.6-t2v", prompt: "video", cfg: {}, ...overrides };
}
type Timeout = Parameters<typeof downloadVideos>[0]["timeoutMs"];
const downloadDefaults = { providerLabel: "Alibaba Wan", maxBytes: 10 * 1024 * 1024 };
function downloadVideo(fetchFn: typeof fetch, timeoutMs: Timeout = 5_000, urls = [videoUrl]) {
  return downloadVideos({ ...downloadDefaults, urls, timeoutMs, fetchFn });
}
function runTask(fetchFn: typeof fetch, options: Partial<Parameters<typeof generateTask>[0]> = {}) {
  return generateTask({
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
function videoResponse(body = "mp4-bytes", contentType = "video/mp4") {
  const headers = contentType ? { "content-type": contentType } : undefined;
  return new Response(Buffer.from(body), { headers });
}
const malformed = "Alibaba Wan generated video download: malformed video response";
const resolverFailure = "remaining-budget resolver failed";
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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
  // An unread debug clone holds the tee; never await its cancellation.
  const release = () => void (captured ?? response).body?.cancel().catch(() => undefined);
  return { response, fetchFn, requests, release };
}

type Stage = "submit" | "poll" | "download";
function taskFetch(responses: Partial<Record<Stage, Response>> = {}) {
  const calls: Array<{ signal?: AbortSignal | null }> = [];
  const defaults = {
    submit: Response.json({ output: { task_id: "task-123" } }),
    poll: Response.json({ output: { task_status: "SUCCEEDED", video_url: videoUrl } }),
    download: videoResponse(),
  };
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    const path = url instanceof Request ? url.url : String(url);
    const stage = path.includes("video-synthesis")
      ? "submit"
      : path.includes("/tasks/task-123")
        ? "poll"
        : "download";
    calls.push({ signal: init?.signal });
    return responses[stage] ?? defaults[stage];
  });
  return { fetchFn, calls };
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
const localImage = { buffer: Buffer.from("png-bytes"), mimeType: "image/png" };
function images(model: string, inputImages: VideoRequest["inputImages"] = [remoteImage]) {
  return { model, inputImages };
}
it.each<[Partial<VideoRequest>, Record<string, unknown>]>([
  [images("wan2.6-i2v"), { img_url: imageUrl }],
  [images("wan2.6-r2v"), { reference_urls: [imageUrl] }],
  [
    {
      provider: "alibaba",
      ...images("wan2.7-r2v", [localImage]),
      inputVideos: [{ url: videoUrl, role: "reference_video" }],
    },
    {
      media: [
        { type: "reference_image", url: "data:image/png;base64,cG5nLWJ5dGVz" },
        { type: "reference_video", url: videoUrl },
      ],
    },
  ],
])("builds mode-specific inputs for %#", (req, expected) => {
  const input = buildInput({ providerLabel: "Qwen", req: videoRequest(req) });
  expect(input).toEqual({ prompt: "video", ...expected });
});
it.each<[string, Partial<VideoRequest>, Record<string, unknown>]>([
  [
    "wan2.6-t2v",
    { resolution: "720P", aspectRatio: "9:16", audio: false },
    { size: "720*1280", audio: false },
  ],
  ["wan2.6-i2v", { resolution: "1080P", audio: true }, { resolution: "1080P", audio: true }],
  ["wan2.7-r2v", { size: "1920x1080", audio: false }, { resolution: "1080P", ratio: "16:9" }],
])("builds %s parameters", (model, req, expected) => {
  expect(buildParameters(videoRequest({ model, ...req }))).toEqual(expected);
});
it("rejects an empty video body", async () => {
  await expect(downloadVideo(vi.fn(async () => videoResponse("")))).rejects.toThrow(malformed);
});
it.each([
  [" UNKNOWN ", undefined],
  ["UNKNOWN", "task was deleted"],
])("rejects %s tasks immediately", async (task_status, message) => {
  const taskId = "missing-task";
  const fetchFn = vi.fn(async () => Response.json({ output: { task_status, message } }));
  await expect(
    pollTask({
      providerLabel: "Qwen",
      taskId,
      headers: new Headers(),
      timeoutMs: 80,
      fetchFn,
      baseUrl: "https://example.com",
    }),
  ).rejects.toThrow(
    `Qwen video generation task ${taskId} is unknown or expired${message ? `: ${message}` : ""}`,
  );
  expect(fetchFn).toHaveBeenCalledOnce();
});

async function rejectsInput(patch: Partial<VideoRequest>, error: RegExp) {
  const fetchFn = vi.fn<typeof fetch>();
  const req = videoRequest(patch);
  await expect(runTask(fetchFn, { model: req.model, req })).rejects.toThrow(error);
  expect(fetchFn).not.toHaveBeenCalled();
}
it.each([
  { model: "wan2.6-r2v", inputVideos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }] },
  { model: "wan2.7-r2v", inputVideos: [{ url: "data:video/mp4;base64,dmlkZW8=" }] },
])("rejects non-remote reference videos for $model", (req) =>
  rejectsInput(req, /remote http\(s\) URLs for reference videos/u),
);

const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
it.each([
  images("wan2.6-i2v", [{ buffer: oversized, mimeType: "image/png" }]),
  images("wan2.7-r2v", [{ buffer: oversized, mimeType: "image/png" }]),
  images("wan2.6-i2v", [{ url: `data:image/png;base64,${oversized.toString("base64")}` }]),
])("rejects oversized reference images for $model (%#)", (req) =>
  rejectsInput(req, /reference image exceeds the 20 MB limit/u),
);
it.each([
  images("wan2.5-t2v-preview"),
  images("wan2.6-t2v", [remoteImage, { url: "https://example.com/2.png" }]),
])("rejects reference media for $model", (req) =>
  rejectsInput(req, /text-to-video.*does not accept reference media/u),
);
it("rejects local images on Wan 2.6 reference-to-video", () =>
  rejectsInput(
    images("wan2.6-r2v", [{ buffer: localImage.buffer }]),
    /requires remote http\(s\) URLs for reference images/u,
  ));

describe("DashScope operation deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const timeoutPattern = /timed out|budget exhausted/;
  async function timesOut(operation: Promise<unknown>, ms: number, pattern = timeoutPattern) {
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
  it.each([false, true])(
    "releases a malformed streaming body (capture tee=%s)",
    async (capture) => {
      const order: string[] = [];
      const cancel = vi.fn(async () => {
        order.push("cancel-started");
        await Promise.resolve();
        order.push("cancel-completed");
      });
      const fixture = streamFixture(
        {
          start(controller) {
            controller.enqueue(new TextEncoder().encode("streaming"));
          },
          cancel,
        },
        capture,
        "application/json",
      );
      try {
        await expect(downloadVideo(fixture.fetchFn)).rejects.toThrow(malformed);
        if (!capture) {
          expect(order).toEqual(["cancel-started", "cancel-completed"]);
        }
      } finally {
        fixture.release();
      }
    },
    2_000,
  );
  it.each([false, true])(
    "times out a valid streaming video body (capture tee=%s)",
    async (capture) => {
      const fixture = streamFixture(
        {
          start(controller) {
            if (capture) {
              controller.enqueue(new TextEncoder().encode("streaming"));
            }
          },
        },
        capture,
      );
      try {
        await timesOut(
          downloadVideo(fixture.fetchFn, 80),
          80,
          /Alibaba Wan generated video download timed out/,
        );
        expect(fixture.requests[0]?.signal?.aborted).toBe(true);
        expect(fixture.fetchFn).toHaveBeenCalledOnce();
      } finally {
        fixture.release();
      }
    },
  );
  it("fails closed before fetch when a function-valued remaining budget is exhausted", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(downloadVideo(fetchFn, () => 0)).rejects.toThrow("remaining budget exhausted");
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("releases the guarded fetch when the remaining-budget resolver throws", async () => {
    const cancelBody = vi.fn();
    const timeoutMs = vi
      .fn<() => number>()
      .mockReturnValueOnce(100)
      .mockImplementationOnce(() => {
        throw new Error(resolverFailure);
      });
    const fixture = streamFixture({ cancel: cancelBody });
    await expect(downloadVideo(fixture.fetchFn, timeoutMs)).rejects.toThrow(resolverFailure);
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(fixture.requests[0]).toMatchObject({ aborted: false, signal: { aborted: true } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    ["submit", 200, 1],
    ["poll", 200, 2],
    ["download", 200, 3],
    ["submit", 503, 1],
    ["poll", 503, 2],
    ["download", 503, 3],
  ] as const)(
    "bounds trickling %s HTTP %s bodies with the operation deadline",
    async (stage, status, callCount) => {
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
        stage === "download" ? "video/mp4" : "application/json",
        status,
      );
      const { fetchFn, calls } = taskFetch({ [stage]: fixture.response });
      try {
        await timesOut(runTask(fetchFn, { timeoutMs: 100 }), 100);
        expect(cancel).toHaveBeenCalledOnce();
        expect(calls.every(({ signal }) => signal?.aborted)).toBe(true);
        expect(fetchFn).toHaveBeenCalledTimes(callCount);
      } finally {
        fixture.release();
      }
    },
  );
  it("does not reset a numeric budget between sequential downloads or after headers", async () => {
    const fetchFn = vi.fn(async () => {
      await delay(40);
      return streamFixture({
        async start(controller) {
          await delay(20);
          controller.enqueue(new TextEncoder().encode("video"));
          controller.close();
        },
      }).response;
    });
    await timesOut(
      downloadVideo(fetchFn, 100, ["https://example.com/1.mp4", "https://example.com/2.mp4"]),
      101,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("bounds retry backoff by the remaining budget", async () => {
    const fetchFn = vi.fn(async () => new Response("busy", { status: 503 }));
    await timesOut(downloadVideo(fetchFn, 100), 100, /timed out/);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["VIDEO/MP4; codecs=avc1", "application/octet-stream", ""])(
    "retries within budget and preserves video bytes (%s)",
    async (contentType) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ output: { task_id: "task-123" } }))
        .mockResolvedValueOnce(
          Response.json({ output: { task_status: "SUCCEEDED", video_url: videoUrl } }),
        )
        .mockResolvedValueOnce(new Response("busy", { status: 503 }))
        .mockResolvedValueOnce(videoResponse("video", contentType));
      const operation = runTask(fetchFn, { timeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(250);
      expect((await operation).videos).toMatchObject([
        {
          buffer: Buffer.from("video"),
          fileName: "video-1.mp4",
          mimeType: contentType || "video/mp4",
        },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("charges submission and poll waits to the default operation budget", async () => {
    const fetchFn = vi.fn(async () => {
      await delay(30);
      const output =
        fetchFn.mock.calls.length === 1 ? { task_id: "pending" } : { task_status: "PENDING" };
      return Response.json({ output });
    });
    await timesOut(runTask(fetchFn, { defaultTimeoutMs: 100 }), 100, /timed out after 100ms/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

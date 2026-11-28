// @vitest-environment node
// Controlled worker events exercise the production wrapper, not real WebCodecs.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  compressChatAttachmentVideo,
  describeVideoCompressionFailure,
  type VideoCompressionResponse,
} from "./chat-attachment-video.ts";

class WorkerFixture extends EventTarget {
  static jobs: WorkerFixture[] = [];
  static failure: "start" | "post" | undefined;
  terminate = vi.fn();
  constructor() {
    super();
    if (WorkerFixture.failure === "start") {
      throw new Error("private start details");
    }
    WorkerFixture.jobs.push(this);
  }
  postMessage() {
    if (WorkerFixture.failure === "post") {
      throw new Error("private post details");
    }
  }
  reply(data: VideoCompressionResponse) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
const source = new File(["source"], "synthetic.mp4", { type: "video/mp4" });
const prepared = new File(["copy"], "synthetic.webm", { type: "video/webm" });
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const controllers: AbortController[] = [];
function start(progress = vi.fn()) {
  const controller = new AbortController();
  controllers.push(controller);
  const result = compressChatAttachmentVideo(source, 100, controller.signal, progress);
  const outcome = result.then(
    (file) => ({ file }),
    (error: unknown) => ({ error }),
  );
  return { controller, result, outcome, progress };
}
beforeEach(() => {
  WorkerFixture.jobs = [];
  WorkerFixture.failure = undefined;
  vi.stubGlobal("Worker", WorkerFixture);
});
afterEach(async () => {
  controllers.splice(0).forEach((c) => c.abort());
  await tick();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["start", "post", "runtime", "message", "stall"] as const)(
  "reports sanitized worker/%s and releases its queue slot",
  async (code) => {
    vi.useFakeTimers();
    if (code === "start" || code === "post") {
      WorkerFixture.failure = code;
    }
    const job = start();
    await tick();
    const worker = WorkerFixture.jobs[0];
    if (code === "runtime") {
      worker!.dispatchEvent(new Event("error"));
    }
    if (code === "message") {
      worker!.dispatchEvent(new Event("messageerror"));
    }
    if (code === "stall") {
      await vi.advanceTimersByTimeAsync(120_000);
    }
    const outcome = await job.outcome;
    if (!("error" in outcome)) {
      throw new Error("Expected failure");
    }
    expect(describeVideoCompressionFailure(outcome.error)).toMatchObject({
      reason: "failed",
      diagnostic: "worker/" + code,
    });
    if (worker) {
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
    WorkerFixture.failure = undefined;
    const next = start();
    await tick();
    WorkerFixture.jobs.at(-1)!.reply({ type: "ready", file: prepared });
    await expect(next.result).resolves.toBe(prepared);
  },
);

it.each(["unsupported", "too-large", "failed"] as const)(
  "preserves normalized encoding/%s without exception content",
  async (reason) => {
    const job = start();
    await tick();
    WorkerFixture.jobs[0]!.reply({ type: "error", reason, stage: "encoding" });
    const outcome = await job.outcome;
    if (!("error" in outcome)) {
      throw new Error("Expected failure");
    }
    expect(describeVideoCompressionFailure(outcome.error)).toMatchObject({
      reason,
      diagnostic: "encoding/" + reason,
    });
  },
);

it("cancels queued work without creating a worker and ignores late results after active cancellation", async () => {
  const active = start();
  const queued = start();
  await tick();
  queued.controller.abort();
  active.controller.abort();
  WorkerFixture.jobs[0]!.reply({ type: "ready", file: prepared });
  const outcomes = await Promise.all([active.outcome, queued.outcome]);
  expect(outcomes.every((outcome) => "error" in outcome)).toBe(true);
  expect(WorkerFixture.jobs).toHaveLength(1);
  expect(WorkerFixture.jobs[0]!.terminate).toHaveBeenCalledOnce();
});

it("resets the stall deadline on progress and settles once", async () => {
  vi.useFakeTimers();
  const job = start();
  await tick();
  const worker = WorkerFixture.jobs[0]!;
  await vi.advanceTimersByTimeAsync(119_000);
  worker.reply({ type: "progress", progress: 0.5 });
  await vi.advanceTimersByTimeAsync(119_000);
  worker.reply({ type: "ready", file: prepared });
  worker.dispatchEvent(new Event("messageerror"));
  await expect(job.result).resolves.toBe(prepared);
  expect(job.progress).toHaveBeenCalledExactlyOnceWith(0.5);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

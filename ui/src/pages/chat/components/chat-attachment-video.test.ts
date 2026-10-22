// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as toast from "../../../lib/toast.ts";
import { createAttachmentDraft } from "./chat-attachment-preparation.test-support.ts";
import type { VideoCompressionRequest, VideoCompressionResponse } from "./chat-attachment-video.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";

class EncoderWorker extends EventTarget {
  static jobs: EncoderWorker[] = [];
  terminate = vi.fn();
  request?: VideoCompressionRequest;
  postMessage(request: VideoCompressionRequest) {
    this.request = request;
    EncoderWorker.jobs.push(this);
  }
  reply(data: VideoCompressionResponse) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
class Reader extends EventTarget {
  result = "data:video/webm;base64,aGk=";
  abort() {}
  readAsDataURL() {
    this.dispatchEvent(new Event("load"));
  }
}

let draft: ReturnType<typeof createAttachmentDraft>;
const video = () => new File([new Uint8Array(200)], "screen.mp4", { type: "video/mp4" });

async function encoding() {
  const context = draft;
  appendChatAttachmentFiles([video()], context.props);
  const entry = context.reads.project([])[0]!;
  entry.compress?.();
  await vi.waitFor(() => expect(EncoderWorker.jobs).toHaveLength(1));
  return { ...context, entry, worker: EncoderWorker.jobs[0]! };
}

beforeEach(() => {
  EncoderWorker.jobs = [];
  vi.stubGlobal("Worker", EncoderWorker);
  vi.stubGlobal("FileReader", Reader);
  draft = createAttachmentDraft({ maxBytes: 80, maxImageBytes: 80, maxBatchBytes: 100 });
});
afterEach(() => {
  draft.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps consent optional, reserves remaining batch bytes, and leaves small files unchanged", async () => {
  vi.useFakeTimers();
  const { reads, props, attachments } = draft;
  appendChatAttachmentFiles([new File([new Uint8Array(30)], "notes.txt")], props);
  expect(appendChatAttachmentFiles([video()], props)).toBe(1);
  const entry = reads.project(attachments())[1]!;
  expect(entry).toMatchObject({ preparation: "offer", reservedBytes: 70 });
  expect(reads.pendingReads).toBe(1);
  expect(EncoderWorker.jobs).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(entry.preparation).toBe("offer");
  expect(appendChatAttachmentFiles([new File(["x"], "overflow.txt")], props)).toBe(0);
  reads.remove(entry);
  expect(reads.pendingReads).toBe(0);
  const small = new File(["small"], "small.mp4", { type: "video/mp4" });
  appendChatAttachmentFiles([small], props);
  expect(attachments().map((attachment) => attachment.fileName)).toEqual([
    "notes.txt",
    "small.mp4",
  ]);
  expect(EncoderWorker.jobs).toHaveLength(0);
});

it("keeps encoding alive beyond the read timeout and publishes only verified bytes", async () => {
  const { reads, worker, attachments } = await encoding();
  vi.useFakeTimers();
  worker.reply({ type: "progress", progress: 0.4 });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(reads.pendingReads).toBe(1);
  expect(attachments()).toEqual([]);
  expect(reads.project([])[0]?.progress).toBeCloseTo(0.38);
  worker.reply({
    type: "ready",
    file: new File([new Uint8Array(50)], "screen.webm", { type: "video/webm" }),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(reads.pendingReads).toBe(0);
  expect(attachments()[0]).toMatchObject({
    fileName: "screen.webm",
    sizeBytes: 50,
    mimeType: "video/webm",
  });
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it.each(["remove", "reset"] as const)("ignores late replies after %s", async (action) => {
  const { reads, entry, worker, attachments } = await encoding();
  if (action === "remove") {
    reads.remove(entry);
  } else {
    reads.abortReads();
  }
  worker.reply({
    type: "ready",
    file: new File(["late"], "late.webm", { type: "video/webm" }),
  });
  await Promise.resolve();
  expect(reads.pendingReads).toBe(0);
  expect(attachments()).toEqual([]);
  expect(reads.project([])).toHaveLength(0);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it.each(["unsupported", "failed", "oversize"] as const)(
  "handles %s compression errors",
  async (failure) => {
    const notify = vi.spyOn(toast, "showToast");
    const { reads, worker, attachments } = await encoding();
    worker.reply(
      failure === "oversize"
        ? { type: "ready", file: video() }
        : { type: "error", reason: failure },
    );
    await vi.waitFor(() => expect(reads.pendingReads).toBe(0));
    expect(attachments()).toEqual([]);
    expect(reads.failureCount).toBe(1);
    if (failure !== "oversize") {
      expect(reads.project([])[0]).toMatchObject({
        state: "error",
        compress: expect.any(Function),
      });
      expect(notify).not.toHaveBeenCalled();
      return;
    }
    expect(reads.project([])).toHaveLength(0);
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      message: "Video is still too large. Try a smaller file.",
      placement: "top-center",
      severity: "error",
    });
  },
);

it("retries the original video once within the remaining batch budget", async () => {
  const { reads, entry, worker, attachments, props } = await encoding();
  vi.useFakeTimers();
  const id = entry.attachment.id;
  worker.reply({ type: "error", reason: "failed" });
  await vi.advanceTimersByTimeAsync(0);
  expect(reads.pendingReads).toBe(0);
  appendChatAttachmentFiles([new File([new Uint8Array(30)], "notes.txt")], props);
  const retry = entry.compress!;
  retry();
  retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(EncoderWorker.jobs).toHaveLength(2);
  const second = EncoderWorker.jobs[1]!;
  expect(second.request?.file).toBe(worker.request?.file);
  expect(second.request?.maxBytes).toBe(70);
  expect(reads.pendingReads).toBe(1);
  second.reply({
    type: "ready",
    file: new File([new Uint8Array(50)], "screen.mp4", { type: "video/mp4" }),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(reads.pendingReads).toBe(0);
  expect(attachments().map((attachment) => attachment.fileName)).toEqual([
    "screen.mp4",
    "notes.txt",
  ]);
  expect(attachments()[0]?.id).toBe(id);
});

it.each(["remove", "reset"] as const)("cannot retry a failed video after %s", async (action) => {
  const { reads, entry, worker, attachments } = await encoding();
  vi.useFakeTimers();
  worker.reply({ type: "error", reason: "failed" });
  await vi.advanceTimersByTimeAsync(0);
  expect(entry.state).toBe("error");
  const retry = entry.compress!;
  if (action === "remove") {
    reads.remove(entry);
  } else {
    reads.abortReads();
  }
  retry();
  expect(reads.pendingReads).toBe(0);
  expect(reads.project(attachments())).toHaveLength(0);
  expect(EncoderWorker.jobs).toHaveLength(1);
});

it("reports a full batch without restarting the failed encoder", async () => {
  const { reads, entry, worker, props } = await encoding();
  vi.useFakeTimers();
  worker.reply({ type: "error", reason: "failed" });
  await vi.advanceTimersByTimeAsync(0);
  appendChatAttachmentFiles(
    [new File([new Uint8Array(80)], "first.txt"), new File([new Uint8Array(20)], "second.txt")],
    props,
  );
  const notification = vi.spyOn(toast, "showToast");
  entry.compress?.();
  expect(notification).toHaveBeenCalledWith({
    message: "File too large. Try a smaller file.",
    placement: "top-center",
    severity: "error",
  });
  expect(entry.state).toBe("error");
  expect(reads.pendingReads).toBe(0);
  expect(EncoderWorker.jobs).toHaveLength(1);
});

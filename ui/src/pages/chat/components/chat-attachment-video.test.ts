// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as toast from "../../../lib/toast.ts";
import { createAttachmentDraft } from "./chat-attachment-preparation.test-support.ts";
import type { VideoCompressionResponse } from "./chat-attachment-video.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";

class EncoderWorker extends EventTarget {
  static jobs: EncoderWorker[] = [];
  terminate = vi.fn();
  postMessage() {
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
    file: new File([new Uint8Array(50)], "screen-compressed.webm", { type: "video/webm" }),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(reads.pendingReads).toBe(0);
  expect(attachments()[0]).toMatchObject({
    fileName: "screen-compressed.webm",
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

it.each(["unsupported", "failed", "oversize"] as const)("removes %s errors", async (failure) => {
  const notify = vi.spyOn(toast, "showToast");
  const { reads, worker, attachments } = await encoding();
  worker.reply(
    failure === "oversize" ? { type: "ready", file: video() } : { type: "error", reason: failure },
  );
  await vi.waitFor(() => expect(reads.pendingReads).toBe(0));
  expect(attachments()).toEqual([]);
  expect(reads.project([])).toHaveLength(0);
  expect(notify).toHaveBeenCalledExactlyOnceWith({
    message:
      failure === "unsupported"
        ? "This browser cannot compress this video."
        : failure === "oversize"
          ? "Video is still too large. Try a smaller file."
          : "Could not compress video. Try again.",
    placement: "top-center",
    severity: "error",
  });
});

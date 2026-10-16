// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayloads } from "../attachment-payload-store.ts";
import { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";
import type { VideoCompressionRequest, VideoCompressionResponse } from "./chat-attachment-video.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";

class EncoderWorker extends EventTarget {
  static jobs: EncoderWorker[] = [];
  request?: VideoCompressionRequest;
  terminate = vi.fn();
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

const cleanups: Array<() => void> = [];
function draft() {
  let attachments: ChatAttachment[] = [];
  const reads = new ChatAttachmentReadLifecycle(() => {});
  const signal = reads.readSignal;
  const props = {
    attachmentReads: reads,
    readSignal: signal,
    attachmentLimits: { maxBytes: 80, maxImageBytes: 80, maxBatchBytes: 100 },
    getAttachments: () => attachments,
    onAttachmentsChange: (next: ChatAttachment[]) => {
      attachments = next;
    },
    onPendingReadsChange: (delta: 1 | -1) => reads.updatePending(signal, delta),
  };
  cleanups.push(() => {
    reads.abortReads();
    releaseChatAttachmentPayloads(attachments);
  });
  return { reads, props, attachments: () => attachments };
}
const video = () => new File([new Uint8Array(200)], "screen.mp4", { type: "video/mp4" });

beforeEach(() => {
  EncoderWorker.jobs = [];
  vi.stubGlobal("Worker", EncoderWorker);
  vi.stubGlobal("FileReader", Reader);
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("video preparation in the shared attachment owner", () => {
  it("keeps consent optional, reserves remaining batch bytes, and leaves small files unchanged", async () => {
    vi.useFakeTimers();
    const { reads, props, attachments } = draft();
    appendChatAttachmentFiles([new File([new Uint8Array(30)], "notes.txt")], props);
    const source = video();
    expect(appendChatAttachmentFiles([source], props)).toBe(1);
    const entry = reads.project(attachments())[1]!;
    expect(entry.preparation).toBe("offer");
    expect(entry.reservedBytes).toBe(70);
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
    expect(source.size).toBe(200);
  });

  it("keeps encoding alive beyond the read timeout and publishes only verified bytes", async () => {
    const { reads, props, attachments } = draft();
    const source = video();
    appendChatAttachmentFiles([source], props);
    reads.project([])[0]!.compress?.();
    await vi.waitFor(() => expect(EncoderWorker.jobs).toHaveLength(1));
    vi.useFakeTimers();
    const worker = EncoderWorker.jobs[0]!;
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
    expect(source.size).toBe(200);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(["remove", "reset"] as const)(
    "terminates an active worker on %s and ignores late completion",
    async (action) => {
      const { reads, props, attachments } = draft();
      appendChatAttachmentFiles([video()], props);
      const entry = reads.project([])[0]!;
      entry.compress?.();
      await vi.waitFor(() => expect(EncoderWorker.jobs).toHaveLength(1));
      const worker = EncoderWorker.jobs[0]!;
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
    },
  );

  it.each(["unsupported", "failed", "oversize"] as const)(
    "keeps a recoverable failed slot for %s",
    async (failure) => {
      const { reads, props, attachments } = draft();
      appendChatAttachmentFiles([video()], props);
      const entry = reads.project([])[0]!;
      entry.compress?.();
      await vi.waitFor(() => expect(EncoderWorker.jobs).toHaveLength(1));
      EncoderWorker.jobs[0]!.reply(
        failure === "oversize"
          ? { type: "ready", file: video() }
          : { type: "error", reason: failure },
      );
      await vi.waitFor(() => expect(reads.pendingReads).toBe(0));
      expect(entry.state).toBe("error");
      expect(attachments()).toEqual([]);
      reads.remove(entry);
      expect(reads.project([])).toHaveLength(0);
    },
  );
});

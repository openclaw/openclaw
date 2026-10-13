// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import * as payloads from "../attachment-payload-store.ts";
import {
  chatAttachmentBatchBytes,
  resolveChatAttachmentLimits,
} from "./chat-attachment-admission.ts";
import { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";
import {
  appendChatAttachmentFiles,
  chatAttachmentFromDataUrl,
  handleChatAttachmentPaste,
  renderAttachmentPreview,
} from "./chat-attachments.ts";

it("memoizes each advertised policy and derives the default decoded frame budget", () => {
  const policy = {
    maxPayload: 25 * 1024 * 1024,
    attachments: { maxBytes: 20 * 1024 * 1024, maxImageBytes: 6 * 1024 * 1024 },
  };
  const limits = resolveChatAttachmentLimits(policy);
  expect(limits).toEqual({ ...policy.attachments, maxBatchBytes: 19_464_192 });
  expect(resolveChatAttachmentLimits(policy)).toBe(limits);
  expect(resolveChatAttachmentLimits({ ...policy, maxPayload: 256 * 1024 })).toEqual({
    ...policy.attachments,
    maxBatchBytes: 0,
  });
  expect(resolveChatAttachmentLimits(undefined)).toBeUndefined();
  expect(resolveChatAttachmentLimits({ maxPayload: policy.maxPayload })).toBeUndefined();
});

it("counts restored payload bytes when size metadata is absent or invalid", () => {
  const attachments: ChatAttachment[] = [
    { id: "size", mimeType: "text/plain", sizeBytes: 4, dataUrl: "data:text/plain;base64,aGk=" },
    { id: "missing", mimeType: "text/plain", dataUrl: "data:text/plain;base64,aGk=" },
    {
      id: "invalid",
      mimeType: "text/plain",
      sizeBytes: Number.NaN,
      dataUrl: "data:text/plain;base64,YQ==",
    },
    {
      id: "negative",
      mimeType: "text/plain",
      sizeBytes: -1,
      dataUrl: "data:text/plain;base64,YWJj",
    },
    { id: "unavailable", mimeType: "text/plain", sizeBytes: Infinity },
  ];
  expect(chatAttachmentBatchBytes(attachments)).toBe(10);
});

it("admits same-name image payloads with independent identities", () => {
  const sources = ["data:image/png;base64,YmVmb3Jl", "data:image/png;base64,YWZ0ZXIh"];
  const attachments = sources.map((source) => {
    const attachment = expectDefined(
      chatAttachmentFromDataUrl(source, "capture.png", undefined, 0),
      "admitted image attachment",
    );
    onTestFinished(() => payloads.releaseChatAttachmentPayload(attachment.id));
    return attachment;
  });

  expect(attachments[0]?.id).not.toBe(attachments[1]?.id);
  expect(attachments.map(({ fileName, sizeBytes }) => ({ fileName, sizeBytes }))).toEqual([
    { fileName: "capture.png", sizeBytes: 6 },
    { fileName: "capture.png", sizeBytes: 6 },
  ]);
  expect(attachments.map(payloads.getChatAttachmentDataUrl)).toEqual(sources);
});

// jsdom omits Blob.arrayBuffer; retain real File identity while supplying the
// browser byte-reading contract from this fixture's own bytes.
function resizePngFixture(bytes?: Uint8Array<ArrayBuffer>): File {
  const data =
    bytes ??
    Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhZkAAAAASUVORK5CYII=",
      ),
      (char) => char.charCodeAt(0),
    );
  const file = new File([data], "large.png", { type: "image/png" });
  file.arrayBuffer = async () => data.slice().buffer;
  const slice = file.slice.bind(file);
  file.slice = (start, end, contentType) => {
    const blob = slice(start, end, contentType);
    blob.arrayBuffer = async () => data.slice(start, end).buffer;
    return blob;
  };
  return file;
}

class StubFileReader {
  static failNames = new Set<string>();
  static heldNames = new Set<string>();
  result: string | ArrayBuffer | null = null;
  private listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener() {}
  abort() {}

  readAsDataURL(file: File) {
    if (StubFileReader.heldNames.has(file.name)) {
      return;
    }
    queueMicrotask(() => {
      if (StubFileReader.failNames.has(file.name)) {
        this.emit("error");
        return;
      }
      this.result = "data:image/png;base64,aGk=";
      this.emit("load");
    });
  }

  private emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function pasteEventWithFiles(files: File[], text = ""): ClipboardEvent {
  return {
    preventDefault: () => {},
    clipboardData: {
      items: files.map((file) => ({
        type: file.type,
        getAsFile: () => file,
      })),
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  } as unknown as ClipboardEvent;
}

describe("chat attachment read failures", () => {
  let toastHost: HTMLElementTagNameMap["openclaw-toast-host"];

  beforeEach(() => {
    vi.stubGlobal("FileReader", StubFileReader as unknown as typeof FileReader);
    StubFileReader.failNames = new Set();
    StubFileReader.heldNames = new Set();
    toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    "retains published payload custody when remaining reads abort (presented=%s)",
    async (presented) => {
      StubFileReader.heldNames.add("held.png");
      const registered = vi.spyOn(payloads, "registerChatAttachmentPayload");
      const create = vi.fn(() => "blob:completed-paste");
      const revoke = vi.fn();
      vi.stubGlobal(
        "URL",
        class extends URL {
          static override createObjectURL = create;
          static override revokeObjectURL = revoke;
        },
      );
      const reads = new ChatAttachmentReadLifecycle(() => {});
      const signal = reads.readSignal;
      let attachments: ChatAttachment[] = [];
      const onAttachmentsChange = vi.fn((next: ChatAttachment[]) => {
        attachments = next;
      });
      handleChatAttachmentPaste(
        pasteEventWithFiles([
          new File(["hi"], "completed.png", { type: "image/png" }),
          new File(["held"], "held.png", { type: "image/png" }),
        ]),
        {
          attachments,
          attachmentReads: reads,
          getAttachments: () => attachments,
          readSignal: signal,
          onAttachmentsChange,
          onPendingReadsChange: (delta) => reads.updatePending(signal, delta),
        },
      );
      await vi.waitFor(() => expect(registered).toHaveBeenCalledOnce());
      const attachment = expectDefined(
        registered.mock.calls[0]?.[0].attachment,
        "completed payload",
      );
      onTestFinished(() => payloads.releaseChatAttachmentPayload(attachment.id));
      expect(payloads.getChatAttachmentDataUrl(attachment)).toBe("data:image/png;base64,aGk=");
      expect(create).not.toHaveBeenCalled();
      expect(reads.pendingReads).toBe(1);
      if (presented) {
        expect(payloads.getChatAttachmentPreviewUrl(attachment)).toBe("blob:completed-paste");
      }

      reads.abortReads();

      expect(payloads.getChatAttachmentDataUrl(attachment)).toBe("data:image/png;base64,aGk=");
      expect(payloads.getChatAttachmentBlob(attachment)).not.toBeNull();
      expect(reads.pendingReads).toBe(0);
      expect(attachments).toEqual([attachment]);
      expect(create).toHaveBeenCalledTimes(presented ? 1 : 0);
      expect(revoke).not.toHaveBeenCalled();
      payloads.releaseChatAttachmentPayload(attachment.id);
      expect(revoke.mock.calls).toEqual(presented ? [["blob:completed-paste"]] : []);
    },
  );

  it.each(["error", "timeout"])("settles a read %s into a failed tile", async (failure) => {
    const files =
      failure === "error"
        ? [
            new File(["ok"], "good.png", { type: "image/png" }),
            new File(["broken"], "bad.png", { type: "image/png" }),
          ]
        : [new File(["stalled"], "stalled.png", { type: "image/png" })];
    if (failure === "error") {
      StubFileReader.failNames.add("bad.png");
    } else {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      StubFileReader.heldNames.add("stalled.png");
    }
    let attachments: ChatAttachment[] = [];
    const container = document.createElement("div");
    const redraw = () =>
      render(
        renderAttachmentPreview({
          attachments,
          attachmentReads: reads,
          getAttachments: () => attachments,
          onAttachmentsChange: (next) => {
            attachments = next;
            redraw();
          },
        }),
        container,
      );
    const reads = new ChatAttachmentReadLifecycle(redraw);
    const signal = reads.readSignal;
    onTestFinished(() => {
      reads.abortReads();
      payloads.releaseChatAttachmentPayloads(attachments);
      render(null, container);
    });
    handleChatAttachmentPaste(pasteEventWithFiles(files), {
      attachments,
      attachmentReads: reads,
      getAttachments: () => attachments,
      readSignal: signal,
      onPendingReadsChange: (delta) => reads.updatePending(signal, delta),
      onAttachmentsChange: (next) => {
        attachments = next;
        redraw();
      },
    });
    if (failure === "error") {
      expect(container.querySelectorAll('.chat-attachment-thumb[aria-busy="true"]')).toHaveLength(
        2,
      );
      await vi.waitFor(() => expect(reads.pendingReads).toBe(0));
      await toastHost.updateComplete;
      expect(toastHost.querySelector(".app-toast")).toBeNull();
      expect(attachments.map(({ fileName }) => fileName)).toEqual(["good.png"]);
      const tiles = container.querySelectorAll(".chat-attachment-thumb");
      expect(tiles).toHaveLength(2);
      expect(tiles[0]?.querySelector("img")?.alt).toBe("good.png");
      expect(
        tiles[1]?.querySelector('.chat-attachment-error[role="img"]')?.getAttribute("aria-label"),
      ).toContain("bad.png");
      const tooltips = [...(tiles[1]?.querySelectorAll("openclaw-tooltip") ?? [])];
      expect(
        tooltips.some(
          (tooltip) => tooltip.content.includes("bad.png") && !tooltip.content.startsWith("Remove"),
        ),
      ).toBe(true);
      expect(tiles[1]?.textContent?.trim()).toBe("");
    } else {
      expect(reads.pendingReads).toBe(1);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(reads.pendingReads).toBe(0);
      expect(container.querySelector(".chat-attachment-thumb--error")).not.toBeNull();
      expect(container.querySelector(".chat-attachment-error")).not.toBeNull();
      const removeButton = container.querySelector<HTMLButtonElement>(".chat-attachment-remove");
      expect(removeButton).not.toBeNull();
      removeButton?.click();
      expect(reads.pendingReads).toBe(0);
      expect(container.querySelector(".chat-attachment-thumb")).toBeNull();
    }
  });

  it("rejects batch overflow by name and admits a later smaller file before reading", async () => {
    vi.useFakeTimers();
    const reads = new ChatAttachmentReadLifecycle(() => {});
    onTestFinished(() => {
      reads.abortReads();
      vi.useRealTimers();
    });
    const files = [
      new File(["1234"], "first.png", { type: "image/png" }),
      new File(["5678"], "second.png", { type: "image/png" }),
      new File(["90"], "third.png", { type: "image/png" }),
    ];
    StubFileReader.heldNames = new Set(files.map((file) => file.name));
    const admitted = appendChatAttachmentFiles(files, {
      attachmentLimits: { maxBytes: 8, maxImageBytes: 8, maxBatchBytes: 6 },
      attachmentReads: reads,
      attachments: [],
      onAttachmentsChange: vi.fn(),
    });
    expect(admitted).toBe(2);
    expect(reads.project([]).map(({ attachment }) => attachment.fileName)).toEqual([
      "first.png",
      "third.png",
    ]);
    await toastHost.updateComplete;
    expect(toastHost.querySelectorAll(".app-toast")).toHaveLength(1);
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toBe(
      "Too large to send: second.png",
    );
  });

  it("reserves the batch budget for ready attachments and overlapping in-flight reads", async () => {
    vi.useFakeTimers();
    const reads = new ChatAttachmentReadLifecycle(() => {});
    onTestFinished(() => {
      reads.abortReads();
      vi.useRealTimers();
    });
    StubFileReader.heldNames = new Set(["reading.png", "overflow.png"]);
    const attachments: ChatAttachment[] = [{ id: "ready", mimeType: "image/png", sizeBytes: 3 }];
    const props = {
      attachmentLimits: { maxBytes: 8, maxImageBytes: 8, maxBatchBytes: 8 },
      attachmentReads: reads,
      attachments,
      onAttachmentsChange: vi.fn(),
    };
    expect(
      appendChatAttachmentFiles([new File(["123"], "reading.png", { type: "image/png" })], props),
    ).toBe(1);
    expect(
      appendChatAttachmentFiles([new File(["456"], "overflow.png", { type: "image/png" })], props),
    ).toBe(0);
    expect(
      reads.project(attachments).map(({ attachment }) => attachment.fileName ?? attachment.id),
    ).toEqual(["ready", "reading.png"]);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toBe(
      "Too large to send: overflow.png",
    );
  });

  it("reserves the image ceiling for an oversized PNG while admitting following text files", async () => {
    const started = createDeferred<ResizeWorker>();
    class ResizeWorker extends EventTarget {
      terminate() {}
      postMessage() {
        started.resolve(this);
      }
    }
    vi.stubGlobal("Worker", ResizeWorker);
    const reads = new ChatAttachmentReadLifecycle(() => {});
    let attachments: ChatAttachment[] = [];
    onTestFinished(() => {
      reads.abortReads();
      payloads.releaseChatAttachmentPayloads(attachments);
    });
    const props = {
      attachmentLimits: { maxBytes: 8, maxImageBytes: 4, maxBatchBytes: 8 },
      attachmentReads: reads,
      getAttachments: () => attachments,
      onAttachmentsChange: (next: ChatAttachment[]) => {
        attachments = next;
      },
    };
    expect(
      appendChatAttachmentFiles(
        [resizePngFixture(), new File(["1"], "first.txt", { type: "text/plain" })],
        props,
      ),
    ).toBe(2);
    await started.promise;
    expect(attachments.map(({ fileName }) => fileName)).toEqual(["first.txt"]);
    expect(
      appendChatAttachmentFiles(
        [
          new File(["234"], "fits.txt", { type: "text/plain" }),
          new File(["56789"], "overflow.txt", { type: "text/plain" }),
        ],
        props,
      ),
    ).toBe(1);
    expect(reads.project(attachments).map(({ attachment }) => attachment.fileName)).toEqual([
      "large.png",
      "first.txt",
      "fits.txt",
    ]);
    await toastHost.updateComplete;
    expect(toastHost.querySelectorAll(".app-toast")).toHaveLength(1);
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toBe(
      "Too large to send: overflow.txt",
    );
  });

  it("rejects oversized non-resizable images against hello policy before encoding", async () => {
    const onAttachmentsChange = vi.fn();
    const limits = { maxBytes: 8, maxImageBytes: 4, maxBatchBytes: 8 };
    handleChatAttachmentPaste(
      pasteEventWithFiles([
        new File(["tiny"], "small.png", { type: "image/png" }),
        new File(["way-too-big"], "huge.gif", { type: "image/gif" }),
      ]),
      { attachmentLimits: limits, attachments: [], onAttachmentsChange },
    );
    await vi.waitFor(() => {
      expect(onAttachmentsChange).toHaveBeenCalled();
    });
    await toastHost.updateComplete;
    // Oversized file is named in a toast and never encoded; the small one attaches.
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("huge.gif");
    const attached = onAttachmentsChange.mock.calls[0]?.[0] as Array<{ fileName?: string }>;
    expect(attached).toHaveLength(1);
    expect(attached[0]?.fileName).toBe("small.png");
  });

  it.each<[string, File[], string, number | undefined]>([
    ["huge.gif", [new File(["way-too-big"], "huge.gif", { type: "image/gif" })], "", 4],
    ["empty.png", [new File([], "empty.png", { type: "image/png" })], "", undefined],
    ["pasted-text", [], "x".repeat(2048), 1024],
    ["pasted-image", [], `data:image/gif;base64,${btoa("p".repeat(64))}`, 16],
  ])("rejects %s at intake without publishing it", async (name, files, text, imageLimit) => {
    const onAttachmentsChange = vi.fn();
    handleChatAttachmentPaste(pasteEventWithFiles(files, text), {
      attachmentLimits:
        imageLimit === undefined
          ? undefined
          : { maxBytes: 1024, maxImageBytes: imageLimit, maxBatchBytes: 1024 },
      attachments: [],
      onAttachmentsChange,
    });
    await toastHost.updateComplete;
    await vi.waitFor(() => {
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(name);
    });
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it.each(["abort", "remove", "timeout"] as const)(
    "settles pending image preparation on %s and discards a late worker result",
    async (outcome) => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const started = createDeferred<ResizeWorker>();
      class ResizeWorker extends EventTarget {
        terminate = vi.fn();
        postMessage() {
          started.resolve(this);
        }
      }
      vi.stubGlobal("Worker", ResizeWorker);
      const onAttachmentsChange = vi.fn();
      const registered = vi.spyOn(payloads, "registerChatAttachmentPayload");
      const reads = new ChatAttachmentReadLifecycle(() => {});
      const signal = reads.readSignal;
      const deltas: number[] = [];
      handleChatAttachmentPaste(pasteEventWithFiles([resizePngFixture()]), {
        attachments: [],
        attachmentLimits: { maxBytes: 8, maxImageBytes: 4, maxBatchBytes: 8 },
        attachmentReads: reads,
        readSignal: signal,
        onAttachmentsChange,
        onPendingReadsChange: (delta) => {
          deltas.push(delta);
          reads.updatePending(signal, delta);
        },
      });
      expect(reads.pendingReads).toBe(1);
      const worker = await started.promise;
      if (outcome === "abort") {
        reads.abortReads();
      } else if (outcome === "remove") {
        reads.remove(expectDefined(reads.project([])[0], "pending tile"));
      } else {
        await vi.advanceTimersByTimeAsync(15_001);
        expect(reads.project([])[0]?.state).toBe("error");
      }
      expect(reads.pendingReads).toBe(0);
      expect(worker.terminate).toHaveBeenCalledOnce();
      worker.dispatchEvent(
        new MessageEvent("message", {
          data: new File(["ok"], "large.png", { type: "image/png" }),
        }),
      );
      await Promise.resolve();
      expect(deltas).toEqual([1, -1]);
      expect(onAttachmentsChange).not.toHaveBeenCalled();
      expect(registered).not.toHaveBeenCalled();
    },
  );

  it("skips a canceled queued image without starting a second encoder", async () => {
    const started = createDeferred<ResizeWorker>();
    const created = vi.fn();
    class ResizeWorker extends EventTarget {
      terminate = vi.fn();
      constructor() {
        super();
        created();
      }
      postMessage() {
        started.resolve(this);
      }
    }
    vi.stubGlobal("Worker", ResizeWorker);
    const done = createDeferred();
    const reads = new ChatAttachmentReadLifecycle(() => {});
    const signal = reads.readSignal;
    let attachments: ChatAttachment[] = [];
    onTestFinished(() => {
      reads.abortReads();
      payloads.releaseChatAttachmentPayloads(attachments);
    });
    handleChatAttachmentPaste(pasteEventWithFiles([resizePngFixture(), resizePngFixture()]), {
      attachmentLimits: { maxBytes: 8, maxImageBytes: 4, maxBatchBytes: 8 },
      attachments,
      getAttachments: () => attachments,
      attachmentReads: reads,
      readSignal: signal,
      onAttachmentsChange: (next) => {
        attachments = next;
      },
      onPendingReadsChange: (delta) => {
        reads.updatePending(signal, delta);
        if (reads.pendingReads === 0) {
          done.resolve();
        }
      },
    });
    const worker = await started.promise;
    expect(reads.pendingReads).toBe(2);
    reads.remove(expectDefined(reads.project([])[1], "queued image"));
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: new File(["ok"], "large.png", { type: "image/png" }),
      }),
    );
    await done.promise;
    expect(attachments).toHaveLength(1);
    expect(created).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("gives each queued resize its own processing timeout", async () => {
    vi.useFakeTimers();
    const first = createDeferred<ResizeWorker>();
    const second = createDeferred<ResizeWorker>();
    const pendingStarts = [first, second];
    class ResizeWorker extends EventTarget {
      terminate() {}
      postMessage() {
        expectDefined(pendingStarts.shift(), "expected image worker").resolve(this);
      }
      complete() {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: new File(["ok"], "large.png", { type: "image/png" }),
          }),
        );
      }
    }
    vi.stubGlobal("Worker", ResizeWorker);
    const done = createDeferred();
    const reads = new ChatAttachmentReadLifecycle(() => {});
    const signal = reads.readSignal;
    let attachments: ChatAttachment[] = [];
    onTestFinished(() => {
      reads.abortReads();
      payloads.releaseChatAttachmentPayloads(attachments);
      vi.useRealTimers();
    });
    handleChatAttachmentPaste(pasteEventWithFiles([resizePngFixture(), resizePngFixture()]), {
      attachmentLimits: { maxBytes: 8, maxImageBytes: 4, maxBatchBytes: 8 },
      attachments,
      getAttachments: () => attachments,
      attachmentReads: reads,
      readSignal: signal,
      onAttachmentsChange: (next) => {
        attachments = next;
      },
      onPendingReadsChange: (delta) => {
        reads.updatePending(signal, delta);
        if (reads.pendingReads === 0) {
          done.resolve();
        }
      },
    });
    const worker = await first.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    worker.complete();
    const next = await second.promise;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(reads.pendingReads).toBe(1);
    next.complete();
    await done.promise;
    expect(attachments).toHaveLength(2);
  });

  it.each(["header", "pixels", "animation", "decode"] as const)(
    "keeps a rejected PNG %s as a failed tile and releases send",
    async (failure) => {
      const decode = vi.fn();
      class ResizeWorker extends EventTarget {
        terminate() {}
        postMessage() {
          decode();
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: null })));
        }
      }
      vi.stubGlobal("Worker", ResizeWorker);
      const bytes = new Uint8Array(await resizePngFixture().arrayBuffer());
      let source = bytes;
      if (failure === "header") {
        source = new Uint8Array([1, 2, 3, 4, 5]);
      } else if (failure === "pixels") {
        const header = new DataView(bytes.buffer);
        header.setUint32(16, 10_000);
        header.setUint32(20, 10_000);
      } else if (failure === "animation") {
        // Advertise APNG before IDAT; header admission must refuse before decode.
        const control = new Uint8Array(20);
        const chunk = new DataView(control.buffer);
        chunk.setUint32(0, 8);
        chunk.setUint32(4, 0x6163544c);
        chunk.setUint32(8, 2);
        source = new Uint8Array([...bytes.slice(0, 33), ...control, ...bytes.slice(33)]);
      }
      const file = resizePngFixture(source);
      const done = createDeferred();
      const reads = new ChatAttachmentReadLifecycle(() => {});
      const signal = reads.readSignal;
      const onAttachmentsChange = vi.fn();
      handleChatAttachmentPaste(pasteEventWithFiles([file]), {
        attachments: [],
        attachmentLimits: { maxBytes: 8, maxImageBytes: 4, maxBatchBytes: 8 },
        attachmentReads: reads,
        readSignal: signal,
        onAttachmentsChange,
        onPendingReadsChange: (delta) => {
          reads.updatePending(signal, delta);
          if (delta === -1) {
            done.resolve();
          }
        },
      });
      await done.promise;
      expect(decode).toHaveBeenCalledTimes(failure === "decode" ? 1 : 0);
      expect(reads.pendingReads).toBe(0);
      expect(reads.project([])[0]?.state).toBe("error");
      expect(onAttachmentsChange).not.toHaveBeenCalled();
    },
  );
});

describe("attachment removal names", () => {
  it("removes only the chosen pasted-text card without changing the draft", async () => {
    const pasted = ["first", "second"].map((id): ChatAttachment => ({
      id,
      mimeType: "text/plain",
      fileName: "pasted-text-123.txt",
      origin: "paste",
    }));
    let attachments = [...pasted];
    const onDraftChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const redraw = () =>
      render(
        renderAttachmentPreview({
          attachments,
          getAttachments: () => attachments,
          draft: "Keep this draft",
          onDraftChange,
          onAttachmentsChange: (next) => {
            attachments = next;
            redraw();
          },
        }),
        container,
      );
    onTestFinished(() => {
      render(null, container);
      container.remove();
    });
    redraw();
    const first = container.querySelector<HTMLElement>("openclaw-chat-pasted-text");
    await (first as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    const remove = first?.querySelector<HTMLButtonElement>(".chat-attachment-remove");
    expect(remove?.getAttribute("aria-label")).toBe("Remove pasted-text-123.txt");
    remove?.click();
    expect(attachments).toEqual([pasted[1]]);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("names full filenames and removes only the activated ID, including duplicate names", () => {
    const names = [
      "budget.csv",
      "notes.txt",
      "notes.txt",
      undefined,
      "   ",
      "تقرير-الميزانية.txt",
      "long-".repeat(50) + "report.txt",
    ];
    let attachments: ChatAttachment[] = names.map((fileName, index) => ({
      id: "named-" + index,
      mimeType: "text/plain",
      fileName,
    }));
    const originals = [...attachments];
    const container = document.createElement("div");
    const released = vi.spyOn(payloads, "releaseChatAttachmentPayload");
    const redraw = () =>
      render(
        renderAttachmentPreview({
          attachments,
          getAttachments: () => attachments,
          onAttachmentsChange: (next) => {
            attachments = next;
            redraw();
          },
        }),
        container,
      );
    redraw();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".chat-attachment-remove")];
    const labels = names.map((name) => (name?.trim() ? "Remove " + name : "Remove attachment"));
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(labels);
    expect(
      buttons.map((button) => (button.parentElement as HTMLElement & { content: string }).content),
    ).toEqual(labels);
    buttons[2]?.click();
    expect(attachments.map(({ id }) => id)).toEqual(
      originals.filter((_, index) => index !== 2).map(({ id }) => id),
    );
    expect(released).toHaveBeenCalledExactlyOnceWith("named-2");
    render(null, container);
    released.mockRestore();
  });
});

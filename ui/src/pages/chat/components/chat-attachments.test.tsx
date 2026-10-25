// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import * as toast from "../../../lib/toast.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import * as payloads from "../attachment-payload-store.ts";
import "../../../lib/toast-host.tsx";
import {
  chatAttachmentBatchBytes,
  resolveChatAttachmentLimits,
} from "./chat-attachment-admission.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";
import {
  appendChatAttachmentFiles,
  chatAttachmentFromDataUrl,
  handleChatAttachmentPaste,
} from "./chat-attachments.ts";
import { AttachmentPreview } from "./chat-attachments.tsx";

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
  const attachment = (id: string, sizeBytes?: number, data?: string): ChatAttachment => ({
    id,
    mimeType: "text/plain",
    sizeBytes,
    dataUrl: data ? "data:text/plain;base64," + data : undefined,
  });
  const attachments = [
    attachment("size", 4, "aGk="),
    attachment("missing", undefined, "aGk="),
    attachment("invalid", Number.NaN, "YQ=="),
    attachment("negative", -1, "YWJj"),
    attachment("unavailable", Infinity),
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
  expect(attachments).toMatchObject([
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

class StubFileReader extends EventTarget {
  static failNames = new Set<string>();
  static heldNames = new Set<string>();
  static heldReads: Array<() => void> = [];
  result: string | ArrayBuffer | null = null;
  abort() {}

  readAsDataURL(file: File) {
    const finish = () => {
      if (StubFileReader.failNames.has(file.name)) {
        this.dispatchEvent(new Event("error"));
        return;
      }
      this.result = "data:image/png;base64,aGk=";
      this.dispatchEvent(new Event("load"));
    };
    if (StubFileReader.heldNames.has(file.name)) {
      StubFileReader.heldReads.push(finish);
    } else {
      queueMicrotask(finish);
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

function readFixture(initial: ChatAttachment[] = [], onChange = () => {}) {
  const h = {
    attachments: initial,
    done: createDeferred(),
    reads: new ChatAttachmentReadLifecycle(onChange),
  };
  const { reads, done } = h;
  const signal = reads.readSignal;
  const props = {
    attachmentLimits: { maxBytes: 8, maxImageBytes: 4, maxBatchBytes: 8 },
    attachmentReads: reads,
    readSignal: signal,
    getAttachments: () => h.attachments,
    onAttachmentsChange: vi.fn((next: ChatAttachment[]) => {
      h.attachments = next;
      onChange();
    }),
    onPendingReadsChange: (delta: 1 | -1) => {
      reads.updatePending(signal, delta);
      if (reads.pendingReads === 0) {
        done.resolve();
      }
    },
  };
  onTestFinished(() => {
    reads.abortReads();
    payloads.releaseChatAttachmentPayloads(h.attachments);
  });
  return Object.assign(h, {
    props,
    paste: (files: File[], overrides: ChatAttachmentControlsProps = {}) =>
      handleChatAttachmentPaste(pasteEventWithFiles(files), { ...props, ...overrides }),
    append: (files: File[]) => appendChatAttachmentFiles(files, props),
    names: () =>
      reads.project(h.attachments).map(({ attachment }) => attachment.fileName ?? attachment.id),
  });
}

function previewFixture(
  initial: ChatAttachment[] = [],
  extra: ChatAttachmentControlsProps = {},
  withReads = false,
) {
  const h = readFixture(initial, () => redraw());
  const props = {
    ...h.props,
    ...extra,
    attachmentLimits: undefined,
    attachmentReads: withReads ? h.reads : undefined,
  };
  const view = () => ({ ...props, attachments: h.attachments, readRevision: {} });
  const preview = mountSolid(AttachmentPreview, view());
  const redraw = () => preview.update(view());
  onTestFinished(preview.dispose);
  return Object.assign(h, { container: preview.container, previewProps: props });
}

function fakeTimers() {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

function imageFile(name: string, bytes: string, type = "image/png") {
  return new File([bytes], name, { type });
}

class ResizeWorker extends EventTarget {
  terminate = vi.fn();
  complete(data: File | null = imageFile("large.png", "ok")) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function mockResizeWorker(start: (worker: ResizeWorker) => void, created = vi.fn()) {
  vi.stubGlobal(
    "Worker",
    class extends ResizeWorker {
      constructor() {
        super();
        created();
      }
      postMessage() {
        start(this);
      }
    },
  );
  return created;
}

describe("chat attachment read failures", () => {
  let toastHost: HTMLElementTagNameMap["openclaw-toast-host"];

  beforeEach(() => {
    vi.stubGlobal("FileReader", StubFileReader as unknown as typeof FileReader);
    StubFileReader.failNames = new Set();
    StubFileReader.heldNames = new Set();
    StubFileReader.heldReads = [];
    toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function expectAttachmentToast(message = "File too large. Try a smaller file.") {
    await toastHost.updateComplete;
    await vi.dynamicImportSettled();
    await waitForSolid(() => {
      expect(toastHost.querySelectorAll(".app-toast")).toHaveLength(1);
      expect(toastHost.querySelector(".app-toast__message")).toMatchObject({
        textContent: message,
      });
    });
  }

  it("retains published payload custody when remaining reads abort", async () => {
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
    const h = readFixture();
    const { reads } = h;
    h.paste([imageFile("completed.png", "hi"), imageFile("held.png", "held")], {
      attachmentLimits: undefined,
    });
    await vi.waitFor(() => expect(registered).toHaveBeenCalledOnce());
    const attachment = expectDefined(registered.mock.calls[0]?.[0].attachment, "completed payload");
    onTestFinished(() => payloads.releaseChatAttachmentPayload(attachment.id));
    expect(payloads.getChatAttachmentDataUrl(attachment)).toBe("data:image/png;base64,aGk=");
    expect(create).not.toHaveBeenCalled();
    expect(reads.pendingReads).toBe(1);
    expect(payloads.getChatAttachmentPreviewUrl(attachment)).toBe("blob:completed-paste");

    reads.abortReads();

    expect(payloads.getChatAttachmentDataUrl(attachment)).toBe("data:image/png;base64,aGk=");
    expect(payloads.getChatAttachmentBlob(attachment)).not.toBeNull();
    expect(h).toMatchObject({ reads: { pendingReads: 0 }, attachments: [attachment] });
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    payloads.releaseChatAttachmentPayload(attachment.id);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:completed-paste");
  });

  it.each(["error", "timeout"])(
    "removes a failed read %s and reports it in a toast",
    async (failure) => {
      fakeTimers();
      StubFileReader.failNames.add("bad.png");
      StubFileReader.heldNames.add("bad.png");
      const h = readFixture();
      h.paste([imageFile("good.png", "ok"), imageFile("bad.png", "broken")], {
        attachmentLimits: undefined,
      });
      expect(h.reads.pendingReads).toBe(2);
      if (failure === "error") {
        StubFileReader.heldReads.splice(0).forEach((finish) => finish());
      }
      await vi.advanceTimersByTimeAsync(failure === "error" ? 0 : 15_001);
      expect(h.reads.pendingReads).toBe(0);
      expect(h.attachments.map(({ fileName }) => fileName)).toEqual(["good.png"]);
      await expectAttachmentToast("Could not attach file. Try again.");
    },
  );

  it.each([
    {
      mode: "batch overflow admits a later smaller file",
      ready: [],
      limit: 6,
      batches: [
        [
          imageFile("first.png", "1234"),
          imageFile("second.png", "5678"),
          imageFile("third.png", "90"),
        ],
      ],
      admitted: [2],
      names: ["first.png", "third.png"],
      rejected: "second.png",
    },
    {
      mode: "ready and overlapping reads reserve the budget",
      ready: [{ id: "ready", mimeType: "image/png", sizeBytes: 3 }],
      limit: 8,
      batches: [[imageFile("reading.png", "123")], [imageFile("overflow.png", "456")]],
      admitted: [1, 0],
      names: ["ready", "reading.png"],
      rejected: "overflow.png",
    },
    {
      mode: "mixed empty and oversized failures report once",
      ready: [],
      limit: 8,
      batches: [
        [new File([], "empty.txt"), imageFile("oversized.gif", "too many bytes", "image/gif")],
      ],
      admitted: [0],
      names: [],
      rejected: "oversized.gif",
    },
  ])("enforces admission: $mode", async ({ ready, limit, batches, admitted, names, rejected }) => {
    fakeTimers();
    const read = vi.spyOn(StubFileReader.prototype, "readAsDataURL");
    const notify = vi.spyOn(toast, "showToast");
    const h = readFixture(ready);
    h.props.attachmentLimits = { maxBytes: 8, maxImageBytes: 8, maxBatchBytes: limit };
    StubFileReader.heldNames = new Set(batches.flat().map((file) => file.name));
    for (const [index, files] of batches.entries()) {
      expect(h.append(files)).toBe(admitted[index]);
    }
    expect(h.names()).toEqual(names);
    expect(read.mock.calls.map(([file]) => file.name)).not.toContain(rejected);
    await expectAttachmentToast();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("reserves the image ceiling for an oversized PNG while admitting following text files", async () => {
    const started = createDeferred<ResizeWorker>();
    mockResizeWorker((worker) => started.resolve(worker));
    const h = readFixture();
    expect(h.append([resizePngFixture(), imageFile("first.txt", "1", "text/plain")])).toBe(2);
    await started.promise;
    expect(h.attachments.map(({ fileName }) => fileName)).toEqual(["first.txt"]);
    expect(
      h.append([
        imageFile("fits.txt", "234", "text/plain"),
        imageFile("overflow.txt", "56789", "text/plain"),
      ]),
    ).toBe(1);
    expect(h.names()).toEqual(["large.png", "first.txt", "fits.txt"]);
    await expectAttachmentToast();
  });

  it.each<[string, File[], string, number | undefined]>([
    ["empty.png", [new File([], "empty.png", { type: "image/png" })], "", undefined],
    ["pasted-text", [], "x".repeat(2048), 1024],
    ["pasted-image", [], `data:image/gif;base64,${btoa("p".repeat(64))}`, 16],
  ])("rejects %s at intake", async (name, files, text, imageLimit) => {
    const onAttachmentsChange = vi.fn<(attachments: ChatAttachment[]) => void>();
    handleChatAttachmentPaste(pasteEventWithFiles(files, text), {
      draft: "Review the attachment",
      attachmentLimits:
        imageLimit === undefined
          ? undefined
          : { maxBytes: 1024, maxImageBytes: imageLimit, maxBatchBytes: 1024 },
      attachments: [],
      onAttachmentsChange,
    });
    await toastHost.updateComplete;
    await vi.waitFor(() =>
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
        name === "empty.png"
          ? "Could not attach file. Try again."
          : "File too large. Try a smaller file.",
      ),
    );
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it.each(["abort", "remove", "timeout"] as const)(
    "settles pending image preparation on %s and discards a late worker result",
    async (outcome) => {
      fakeTimers();
      const started = createDeferred<ResizeWorker>();
      mockResizeWorker((worker) => started.resolve(worker));
      const h = readFixture();
      const { reads, props } = h;
      const registered = vi.spyOn(payloads, "registerChatAttachmentPayload");
      const pending = vi.fn(props.onPendingReadsChange);
      h.paste([resizePngFixture()], { onPendingReadsChange: pending });
      expect(reads.pendingReads).toBe(1);
      const worker = await started.promise;
      if (outcome === "abort") {
        reads.abortReads();
      } else if (outcome === "remove") {
        reads.remove(expectDefined(reads.project([])[0], "pending tile"));
      } else {
        await vi.advanceTimersByTimeAsync(15_001);
        expect(reads.project([])).toHaveLength(0);
      }
      expect(reads.pendingReads).toBe(0);
      expect(worker.terminate).toHaveBeenCalledOnce();
      worker.complete();
      await Promise.resolve();
      expect(pending.mock.calls).toEqual([[1], [-1]]);
      expect(props.onAttachmentsChange).not.toHaveBeenCalled();
      expect(registered).not.toHaveBeenCalled();
    },
  );

  it("skips a canceled queued image without starting a second encoder", async () => {
    const started = createDeferred<ResizeWorker>();
    const created = mockResizeWorker((worker) => started.resolve(worker));
    const h = readFixture();
    const { reads, done } = h;
    h.paste([resizePngFixture(), resizePngFixture()]);
    const worker = await started.promise;
    expect(reads.pendingReads).toBe(2);
    reads.remove(expectDefined(reads.project([])[1], "queued image"));
    worker.complete();
    await done.promise;
    expect(h.attachments).toHaveLength(1);
    expect(created).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("gives each queued resize its own processing timeout", async () => {
    fakeTimers();
    const first = createDeferred<ResizeWorker>();
    const second = createDeferred<ResizeWorker>();
    const pendingStarts = [first, second];
    mockResizeWorker((worker) =>
      expectDefined(pendingStarts.shift(), "expected image worker").resolve(worker),
    );
    const h = readFixture();
    const { reads, done } = h;
    h.paste([resizePngFixture(), resizePngFixture()]);
    const worker = await first.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    worker.complete();
    const next = await second.promise;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(reads.pendingReads).toBe(1);
    next.complete();
    await done.promise;
    expect(h.attachments).toHaveLength(2);
  });

  it.each(["header", "pixels", "animation", "decode"] as const)(
    "removes a failed PNG %s and releases send",
    async (failure) => {
      const decode = vi.fn();
      mockResizeWorker((worker) => {
        decode();
        queueMicrotask(() => worker.complete(null));
      });
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
      const h = readFixture();
      const { reads, props, done } = h;
      h.paste([file]);
      await done.promise;
      expect(decode).toHaveBeenCalledTimes(failure === "decode" ? 1 : 0);
      expect(reads.pendingReads).toBe(0);
      expect(reads.project([])).toHaveLength(0);
      expect(props.onAttachmentsChange).not.toHaveBeenCalled();
    },
  );
});

it("retains focused pasted-text actions when a peer read completes and uses current controls", async () => {
  vi.stubGlobal("FileReader", StubFileReader as unknown as typeof FileReader);
  StubFileReader.failNames = new Set();
  StubFileReader.heldNames = new Set();
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const pasted: ChatAttachment = {
    id: "pasted",
    mimeType: "text/plain",
    fileName: "pasted-text-123.txt",
    origin: "paste",
    dataUrl: "data:text/plain,Restored%20text",
  };
  const previousDraftChange = vi.fn();
  const currentDraftChange = vi.fn();
  const h = previewFixture(
    [pasted],
    { draft: "Earlier draft", onDraftChange: previousDraftChange },
    true,
  );
  const { container } = h;
  document.body.append(container);
  onTestFinished(() => container.remove());
  h.append([imageFile("peer.png", "hi")]);
  const restore = expectDefined(
    container.querySelector<HTMLButtonElement>(".chat-attachment-text-action"),
    "pasted text restore action",
  );
  const remove = expectDefined(
    container.querySelector<HTMLButtonElement>(".chat-attachment-remove"),
    "pasted text remove action",
  );
  restore.focus();
  expect(document.activeElement).toBe(restore);

  h.previewProps.draft = "Current draft";
  h.previewProps.onDraftChange = currentDraftChange;
  await h.done.promise;

  expect(h.attachments.map(({ fileName }) => fileName)).toEqual([
    "pasted-text-123.txt",
    "peer.png",
  ]);
  expect(container.querySelector(".chat-attachment-text-action")).toBe(restore);
  expect(container.querySelector(".chat-attachment-remove")).toBe(remove);
  expect(document.activeElement).toBe(restore);
  h.previewProps.disabled = true;
  h.props.onAttachmentsChange(h.attachments);
  expect(restore.disabled).toBe(true);
  restore.click();
  expect(currentDraftChange).not.toHaveBeenCalled();

  h.previewProps.disabled = false;
  h.props.onAttachmentsChange(h.attachments);
  expect(restore.disabled).toBe(false);
  restore.click();
  expect(previousDraftChange).not.toHaveBeenCalled();
  expect(currentDraftChange).toHaveBeenCalledExactlyOnceWith("Current draft\n\nRestored text");
  expect(h.attachments.map(({ fileName }) => fileName)).toEqual(["peer.png"]);
});

it.each([false, true])(
  "removes only the activated ID without changing the draft (paste=%s)",
  (paste) => {
    const names = paste
      ? ["pasted-text-123.txt", "pasted-text-123.txt"]
      : ["notes.txt", "notes.txt", undefined, "   "];
    const originals: ChatAttachment[] = names.map((fileName, index) => ({
      id: "named-" + index,
      mimeType: "text/plain",
      fileName,
      origin: paste ? "paste" : "file",
    }));
    const released = vi.spyOn(payloads, "releaseChatAttachmentPayload");
    const onDraftChange = vi.fn();
    const h = previewFixture(originals, { draft: "Keep this draft", onDraftChange });
    const { container } = h;
    document.body.append(container);
    onTestFinished(() => container.remove());
    flush();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".chat-attachment-remove")];
    const labels = names.map((name) => (name?.trim() ? "Remove " + name : "Remove attachment"));
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(labels);
    expect(
      buttons.map((button) => (button.parentElement as HTMLElement & { content: string }).content),
    ).toEqual(labels);
    const removed = paste ? 0 : 1;
    buttons[removed]?.click();
    expect(h.attachments).toEqual(originals.filter((_, index) => index !== removed));
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledExactlyOnceWith(`named-${removed}`);
    released.mockRestore();
  },
);

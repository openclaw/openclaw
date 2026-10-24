/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { createChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
import { ChatAttachmentInputs } from "./chat-attachment-inputs.tsx";
import { createAttachmentDraft } from "./chat-attachment-preparation.test-support.ts";
import { makeMenu } from "./chat-composer-menu.test-support.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import "../../../lib/toast-host.tsx";

let host: HTMLDivElement;
let toastHost: HTMLElement;
let restoreDialog: () => void;

beforeEach(() => {
  restoreDialog = installDialogPolyfill();
  vi.stubGlobal("isSecureContext", true);
  host = document.body.appendChild(document.createElement("div"));
  toastHost = document.body.appendChild(document.createElement("openclaw-toast-host"));
});

afterEach(() => {
  cleanupSolid();
  host.remove();
  toastHost.remove();
  restoreDialog();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function composer(extra: ChatAttachmentControlsProps = {}) {
  const draft = createAttachmentDraft({ maxBytes: 32, maxImageBytes: 32, maxBatchBytes: 64 });
  onTestFinished(draft.dispose);
  const handle = createChatAttachmentInputHandle();
  const view = mountSolid(
    (props: ChatAttachmentControlsProps) => (
      <>
        <ChatAttachmentInputs {...props} inputHandle={handle} />
        <ChatComposerPlusMenu
          menu={makeMenu({ open: true, attachments: props, inputHandle: handle })}
        />
      </>
    ),
    { ...draft.props, ...extra },
    host,
  );
  await waitForSolid(() =>
    expect(host.querySelector('[data-value="file"], [data-value="photo"]')).not.toBeNull(),
  );
  const input = host.querySelector<HTMLInputElement>(".agent-chat__file-input")!;
  const native = vi.spyOn(input, "click").mockImplementation(() => {});
  const open = () => host.querySelector<HTMLButtonElement>('[data-value="file"]')!.click();
  return { draft, view, handle, input, native, open };
}

it("opens unrestricted Files from the real menu and admits arbitrary documents through the draft owner", async () => {
  const stl = new File(["solid test"], "part.stl", { type: "" });
  const unknown = new File(["custom"], "document.unlisted-extension", { type: "" });
  const picker = vi
    .fn()
    .mockResolvedValue([stl, unknown].map((file) => ({ getFile: async () => file })));
  vi.stubGlobal("showOpenFilePicker", picker);
  const { draft, native, open, handle } = await composer();
  expect(host.querySelector('[data-value="file"]')?.textContent).toBe("Files");
  open();
  // The browser must receive the request within this user gesture, before any await.
  expect(picker).toHaveBeenCalledExactlyOnceWith({ multiple: true });
  expect(native).not.toHaveBeenCalled();
  await waitForSolid(() => expect(draft.attachments()).toHaveLength(2));
  expect(draft.attachments().map(({ fileName, mimeType }) => [fileName, mimeType])).toEqual([
    ["part.stl", "application/octet-stream"],
    ["document.unlisted-extension", "application/octet-stream"],
  ]);
  await waitForSolid(() => expect(draft.reads.pendingReads).toBe(0));
  picker.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
  handle.open("file");
  await waitForSolid(() => expect(draft.reads.pendingReads).toBe(0));
  expect(draft.attachments()).toHaveLength(2);
  draft.props.onAttachmentsChange?.([]);
  handle.open("file");
  await waitForSolid(() => expect(draft.attachments()).toHaveLength(2));
});

it.each(["picker", "provider"] as const)(
  "retires late %s results when the mounted composer changes draft",
  async (stage) => {
    const selection = Promise.withResolvers<Pick<FileSystemFileHandle, "getFile">[]>();
    const provider = Promise.withResolvers<File>();
    const getFile = vi.fn(() => provider.promise);
    vi.stubGlobal(
      "showOpenFilePicker",
      vi.fn(() => selection.promise),
    );
    const { draft, view, open } = await composer();
    open();
    if (stage === "provider") {
      selection.resolve([{ getFile }]);
      await waitForSolid(() => expect(getFile).toHaveBeenCalledOnce());
      expect(draft.reads.pendingReads).toBeGreaterThan(0);
    }
    const next = createAttachmentDraft({ maxBytes: 32, maxImageBytes: 32, maxBatchBytes: 64 });
    onTestFinished(next.dispose);
    draft.reads.abortReads();
    view.update(next.props);
    flush();
    selection.resolve([{ getFile }]);
    provider.resolve(new File(["private draft"], "old.txt", { type: "text/plain" }));
    await Promise.resolve();
    await Promise.resolve();
    flush();
    expect(draft.attachments()).toEqual([]);
    expect(next.attachments()).toEqual([]);
    expect(next.reads.pendingReads).toBe(0);
  },
);

it("keeps the send pending during provider reads and preserves size checks and readable siblings", async () => {
  const file = Promise.withResolvers<File>();
  const getFile = vi.fn(() => file.promise);
  vi.stubGlobal(
    "showOpenFilePicker",
    vi.fn().mockResolvedValue([
      { getFile },
      { getFile: async () => new File([], "empty.txt") },
      { getFile: async () => new File(["x".repeat(33)], "oversized.bin") },
      {
        getFile: async () => {
          throw new DOMException("Provider unavailable", "NotReadableError");
        },
      },
    ]),
  );
  const { draft, open } = await composer();
  open();
  await waitForSolid(() => expect(getFile).toHaveBeenCalledOnce());
  expect(draft.reads.pendingReads).toBeGreaterThan(0);
  expect(draft.attachments()).toEqual([]);
  file.resolve(new File(["ready"], "valid.txt", { type: "text/plain" }));
  await waitForSolid(() =>
    expect(draft.attachments().map(({ fileName }) => fileName)).toEqual(["valid.txt"]),
  );
  await waitForSolid(() => expect(draft.reads.pendingReads).toBe(0));
});

it.each(["SecurityError", "NotAllowedError"])(
  "does not silently launch the overlapping input after %s",
  async (name) => {
    const picker = vi.fn().mockRejectedValue(new DOMException("Denied", name));
    vi.stubGlobal("showOpenFilePicker", picker);
    const { draft, native, open } = await composer();
    open();
    await waitForSolid(() => expect(picker).toHaveBeenCalledOnce());
    await waitForSolid(() => expect(draft.reads.pendingReads).toBe(0));
    expect(native).not.toHaveBeenCalled();
    expect(draft.attachments()).toEqual([]);
    await waitForSolid(() =>
      expect(toastHost.textContent).toContain("Could not open the file browser"),
    );
  },
);

it("preserves the existing input when the direct API is absent and for image-only composers", async () => {
  vi.stubGlobal("showOpenFilePicker", undefined);
  const { handle, native, input, view, draft } = await composer();
  handle.open("file");
  expect(native).toHaveBeenCalledOnce();
  expect(input.accept).toBe("");
  const picker = vi.fn();
  vi.stubGlobal("showOpenFilePicker", picker);
  view.update({ ...draft.props, imagesOnly: true });
  flush();
  handle.open("file");
  expect(native).toHaveBeenCalledTimes(2);
  expect(input.accept).toBe("image/*");
  expect(picker).not.toHaveBeenCalled();
});

it.each(["unmount", "timeout"] as const)(
  "releases pending provider work on %s",
  async (retirement) => {
    const provider = Promise.withResolvers<File>();
    const getFile = vi.fn(() => provider.promise);
    vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValue([{ getFile }]));
    const { draft, open } = await composer();
    vi.useFakeTimers();
    open();
    await vi.advanceTimersByTimeAsync(0);
    expect(getFile).toHaveBeenCalledOnce();
    expect(draft.reads.pendingReads).toBe(1);
    if (retirement === "unmount") {
      cleanupSolid();
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await vi.advanceTimersByTimeAsync(15_000);
      flush();
      expect(toastHost.textContent).toContain("Could not attach file. Try again.");
    }
    expect(draft.reads.pendingReads).toBe(0);
    provider.resolve(new File(["late"], "late.txt"));
    await vi.advanceTimersByTimeAsync(0);
    expect(draft.attachments()).toEqual([]);
  },
);

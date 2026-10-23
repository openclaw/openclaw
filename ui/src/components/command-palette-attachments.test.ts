/* @vitest-environment jsdom */

import { createComponent, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { CommandPaletteLoading } from "../app/app-shell-command-palette-loading-view.tsx";
import { ShellCommandPaletteOwner } from "../app/app-shell-command-palette-loading.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  COMMAND_PALETTE_ELEMENT,
  createLazyCustomElementRequests,
} from "../app/lazy-custom-element.ts";
import * as toast from "../lib/toast.ts";
import * as payloads from "../pages/chat/attachment-payload-store.ts";
import { createDraftFixture } from "../pages/new-session/draft-submission-flow.test-support.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  openPalette,
  prepareDraftContext,
  mountPalette,
  paletteInput,
  pressKey,
  setInputValue,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";

let restoreDialog: () => void;
let readers: FileReader[];

beforeEach(() => {
  restoreDialog = installDialogPolyfill();
  readers = [];
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
    readers.push(this);
  });
  vi.spyOn(toast, "showToast").mockReturnValue(true);
});

afterEach(() => {
  document.body.replaceChildren();
  restoreDialog();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

const imageFields = { mimeType: "image/png", fileName: "pasted.png", content: "aW1hZ2U=" };

function createLoading(context?: ApplicationContext) {
  return createRoot((dispose) => {
    onTestFinished(dispose);
    return new ShellCommandPaletteOwner(
      {
        elements: {},
        context,
        commandPaletteElement: COMMAND_PALETTE_ELEMENT,
        lazyCustomElements: createLazyCustomElementRequests(),
        shellNavigation: { chatNavigationOptions: () => undefined, navigate: () => {} },
      },
      { request: () => {}, clear: () => {}, cancel: () => {}, pending: () => false },
    ).loading;
  });
}

function paste(input: HTMLTextAreaElement, files: File[] = [], text = "") {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({ type: file.type, getAsFile: () => file })),
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  input.dispatchEvent(event);
  return event;
}

function image(name = "pasted.png") {
  return new File(["image"], name, { type: "image/png" });
}

function finishRead(index: number, dataUrl = "data:image/png;base64,aW1hZ2U=") {
  const reader = readers[index]!;
  Object.defineProperty(reader, "result", { value: dataUrl });
  reader.dispatchEvent(new ProgressEvent("load"));
}

const key = (input: HTMLTextAreaElement, { key: name = "", ...init }: KeyboardEventInit) =>
  pressKey(input, name, { cancelable: true, ...init });

async function mount(options: Parameters<typeof createDraftFixture>[0] = {}) {
  const fixture = createDraftFixture(options);
  const { context } = fixture;
  const publish = prepareDraftContext(context);
  vi.mocked(context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:image-task",
    initialRun: { status: "idle" },
  });
  const mounted = await mountPalette(context);
  const { palette, query } = mounted;
  await openPalette(palette);
  const input = paletteInput(palette);
  input.focus();
  const start = () => query<HTMLButtonElement>(".cmd-palette__create")!;
  const create = vi.mocked(context.sessions.createResult);
  return {
    ...fixture,
    ...mounted,
    input,
    start,
    publish,
    create,
    expectSubmit: (params: object) =>
      expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(params), {
        reconciliation: "background",
        signal: expect.any(AbortSignal),
      }),
  };
}

describe("command palette attachments", () => {
  it("owns dropped files immediately, retains intent through failures/removal, and clears an empty draft", async () => {
    const { palette, input, query, start, create, context } = await mount();
    const surface = query<HTMLElement>(".cmd-palette")!;
    const dispatch = (type: string, files: File[] = []) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { types: ["Files"], files, dropEffect: "none" },
      });
      surface.dispatchEvent(event);
      return event;
    };
    dispatch("dragenter");
    expect(surface.hasAttribute("data-attachment-drop-active")).toBe(true);
    expect(
      dispatch("drop", [image(), new File(["brief"], "brief.pdf", { type: "application/pdf" })])
        .defaultPrevented,
    ).toBe(true);
    expect(surface.hasAttribute("data-attachment-drop-active")).toBe(false);
    await palette.updateComplete;
    await waitForSolid(() =>
      expect(query(".cmd-palette__search")?.hasAttribute("inert")).toBe(true),
    );
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(input.placeholder).toBe("What would you like to do with these files?");
    expect(start().disabled).toBe(true);
    readers[0]!.dispatchEvent(new ProgressEvent("error"));
    finishRead(1, "data:application/pdf;base64,YnJpZWY=");
    setInputValue(input, "Review");
    await palette.updateComplete;
    await waitForSolid(() => expect(start().disabled).toBe(false));
    expect(create).not.toHaveBeenCalled();
    expect(query(".chat-attachment-thumb--error")).toBeNull();
    expect(query(".chat-attachment-failures")).toBeNull();
    await waitForSolid(() =>
      expect(query(".chat-attachment-file__name")?.textContent).toBe("brief.pdf"),
    );
    expect(toast.showToast).toHaveBeenCalledExactlyOnceWith({
      message: "Could not attach file. Try again.",
      placement: "top-center",
      severity: "error",
    });
    query<HTMLButtonElement>(".chat-attachment-remove")!.click();
    await palette.updateComplete;
    expect(query(".cmd-palette__search")?.hasAttribute("inert")).toBe(true);
    key(input, { key: "Enter" });
    expect(context.navigate).not.toHaveBeenCalled();
    setInputValue(input, "");
    await palette.updateComplete;
    expect(query(".cmd-palette__search")?.hasAttribute("inert")).toBe(false);
  });

  it("keeps ready and pending attachments when dismissed, but releases them on disconnect", async () => {
    const registered = vi.spyOn(payloads, "registerChatAttachmentPayload");
    const { palette, input, query } = await mount();
    paste(input, [image("ready.png"), image("pending.png")]);
    finishRead(0);
    await palette.updateComplete;
    const attachment = registered.mock.calls[0]![0].attachment;
    key(input, { key: "Escape" });
    finishRead(1);
    await palette.updateComplete;
    expect(payloads.getChatAttachmentDataUrl(attachment)).not.toBeNull();
    await openPalette(palette);
    await waitForSolid(() =>
      expect(query(".chat-attachments-preview")?.querySelectorAll("img")).toHaveLength(2),
    );
    palette.remove();
    expect(payloads.getChatAttachmentDataUrl(attachment)).toBeNull();
  });

  it.each([true, false])(
    "keeps non-image paste native with uploads enabled=%s",
    async (uploadsEnabled) => {
      const { query, context, input, create } = await mount();
      context.config.current.uploadsEnabled = uploadsEnabled;
      for (const text of ["ordinary search", "long search ".repeat(200)]) {
        expect(paste(input, [], text).defaultPrevented).toBe(false);
      }
      expect(
        paste(input, [new File(["pdf"], "document.pdf", { type: "application/pdf" })])
          .defaultPrevented,
      ).toBe(false);
      if (!uploadsEnabled) {
        expect(paste(input, [image()]).defaultPrevented).toBe(true);
        const loading = createLoading(context);
        loading.begin();
        const loadingInput = document.createElement("textarea");
        loadingInput.addEventListener("paste", (event) => loading.handlePaste(event));
        expect(paste(loadingInput, [image()]).defaultPrevented).toBe(true);
        expect(loading.captureHandoff()()?.attachmentFiles).toBeUndefined();
      }
      expect(readers).toHaveLength(0);
      expect(query(".chat-attachments-preview")).toBeNull();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("preserves the input and submits text with images in the background", async () => {
    const message = "Describe these images";
    const { palette, input, context, start, query, expectSubmit, create } = await mount();
    setInputValue(input, message);
    input.setSelectionRange(0, Math.min(5, message.length), "backward");
    const selection = [input.selectionStart, input.selectionEnd];
    expect(paste(input, [image()]).defaultPrevented).toBe(true);
    await palette.updateComplete;
    expect(start().disabled).toBe(true);
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(query('.chat-attachment-thumb[aria-busy="true"]')).not.toBeNull(),
    );
    key(input, { key: "Enter", ctrlKey: true });
    expect(create).not.toHaveBeenCalled();
    finishRead(0);
    await vi.waitFor(() => expect(start().disabled).toBe(false));
    expect(query("textarea")).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual(selection);
    const rail = query(".cmd-palette__attachments")!;
    expect(rail.querySelectorAll(".chat-attachment-thumb img")).toHaveLength(1);
    key(input, { key: "Enter", metaKey: true });
    await vi.waitFor(() => expect(palette.isOpen).toBe(false));
    expectSubmit({
      message,
      attachments: [expect.objectContaining({ type: "image", ...imageFields })],
    });
    expect(context.navigateAndWait).not.toHaveBeenCalled();
    expect(context.gateway.setSessionKey).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "owner"])(
    "retires ready payloads and ignores late reads after %s",
    async (reason) => {
      const registered = vi.spyOn(payloads, "registerChatAttachmentPayload");
      const { palette, input, context, publish, query, create } = await mount();
      paste(input, [image("ready.png"), image("pending.png")]);
      finishRead(0);
      await palette.updateComplete;
      const attachment = registered.mock.calls[0]![0].attachment;
      expect(payloads.getChatAttachmentDataUrl(attachment)).not.toBeNull();
      if (reason === "disconnect") {
        palette.remove();
      } else {
        Object.assign(context.gateway, { connectionRevision: 2 });
        publish();
        await palette.updateComplete;
      }
      finishRead(1);
      expect(payloads.getChatAttachmentDataUrl(attachment)).toBeNull();
      expect(registered).toHaveBeenCalledOnce();
      if (reason !== "disconnect") {
        await openPalette(palette);
        expect(query(".chat-attachments-preview")).toBeNull();
      }
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("clears a rejected pasted-data-URL prompt when its image is removed", async () => {
    const { palette, input, create, start, query } = await mount();
    create.mockResolvedValueOnce({
      key: "agent:main:dashboard:rejected-images",
      initialRun: { status: "rejected", error: "Image turn rejected" },
    });
    paste(input, [], "data:image/png;base64,aW1hZ2U=");
    await vi.waitFor(() => expect(start().disabled).toBe(false));
    start().click();
    await vi.waitFor(() =>
      expect(query('[role="alert"]')?.textContent).toContain("Image turn rejected"),
    );
    expect(start().disabled).toBe(true);
    await waitForSolid(() => expect(query(".chat-attachment-thumb img")).not.toBeNull());
    query<HTMLButtonElement>(".chat-attachment-remove")!.click();
    await palette.updateComplete;
    expect(query('[role="alert"]')).toBeNull();
  });

  it.each([
    "ready",
    "policy-delayed",
    "text-policy-delayed",
    "failed",
    "dismissed",
    "oversized",
    "partial",
  ] as const)("settles a cold submit exactly once after %s preparation", async (outcome) => {
    const textOnly = outcome === "text-policy-delayed";
    const delayedPolicy = outcome === "policy-delayed" || textOnly;
    const limited = outcome === "oversized" || outcome === "partial";
    const policy = createDeferred<{ sessionPlacement: Record<string, never> }>();
    const { palette, context, publish, start, query, queryAll, create, expectSubmit } = await mount(
      delayedPolicy ? { placementPolicy: () => policy.promise } : {},
    );
    palette.togglePalette();
    await palette.updateComplete;
    if (limited) {
      Object.assign(context.gateway.snapshot.hello!, {
        policy: {
          maxPayload: 25 * 1024 * 1024,
          attachments: { maxBytes: 65_536, maxImageBytes: 4 },
        },
      });
    }
    const state = createLoading();
    const loader = document.body.appendChild(document.createElement("div"));
    state.begin();
    const loadingView = mountSolid(
      () =>
        createComponent(CommandPaletteLoading, {
          state,
          onClose: () => state.clear(),
        }),
      { container: loader },
    );
    flush();
    const coldInput = loader.querySelector("textarea")!;
    if (outcome !== "ready" && outcome !== "policy-delayed") {
      setInputValue(coldInput, "Keep every image");
    }
    // PNGs enter asynchronous resize preparation; use a non-resizable image
    // to exercise synchronous admission rejection and partial-batch custody.
    const candidate = limited
      ? new File(["image"], "oversized.gif", { type: "image/gif" })
      : image();
    const files =
      outcome === "partial"
        ? [new File(["ok"], "small.png", { type: "image/png" }), candidate]
        : [candidate];
    if (outcome !== "text-policy-delayed") {
      paste(coldInput, files);
    }
    key(coldInput, { key: "Enter", metaKey: true });
    const take = state.captureHandoff();
    palette.openPalette(take);
    await palette.updateComplete;
    const replacement = paletteInput(palette);
    replacement.focus();
    await palette.updateComplete;
    expect(take()).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    if (outcome === "dismissed") {
      key(replacement, { key: "Escape" });
    }
    if (outcome === "failed") {
      readers[0]!.dispatchEvent(new ProgressEvent("error"));
    } else if (outcome !== "oversized" && outcome !== "text-policy-delayed") {
      finishRead(0, outcome === "partial" ? "data:image/png;base64,b2s=" : undefined);
    }
    await palette.updateComplete;
    await palette.updateComplete;
    if (delayedPolicy) {
      expect(create).not.toHaveBeenCalled();
      policy.resolve({ sessionPlacement: {} });
      await context.agents.refreshList();
      publish();
    }
    if (limited) {
      // A valid text/remaining-image prompt could be sent explicitly, but the
      // cold submit must not silently drop a rejected clipboard image.
      await vi.waitFor(() => expect(start().disabled).toBe(false));
      await waitForSolid(() =>
        expect(queryAll(".chat-attachment-thumb")).toHaveLength(outcome === "partial" ? 1 : 0),
      );
      expect(query(".chat-attachment-failures")).toBeNull();
      expect(replacement.value).toBe("Keep every image");
      expect(toast.showToast).toHaveBeenCalledExactlyOnceWith({
        message: "File too large. Try a smaller file.",
        placement: "top-center",
        severity: "error",
      });
    }
    if (outcome === "ready" || delayedPolicy) {
      const submitted = { message: textOnly ? "Keep every image" : "" };
      if (!textOnly) {
        Object.assign(submitted, { attachments: [expect.objectContaining(imageFields)] });
      }
      await vi.waitFor(() => expectSubmit(submitted));
    } else {
      expect(create).not.toHaveBeenCalled();
    }
    loadingView.unmount();
  });
});

it("keeps mobile attachment Return native and starts only from its button", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  const { palette, input, query, start, context, expectSubmit } = await mount();
  paste(input, [image()]);
  finishRead(0);
  input.value = "A mobile prompt";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(start().disabled).toBe(false));
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
    const event = key(input, { key: "Enter", ...modifiers });
    expect(event.defaultPrevented).toBe(false);
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(true);
  }
  expect(start().querySelector("kbd")).toBeNull();
  const footer = query<HTMLElement>(".cmd-palette > .cmd-palette__footer")!;
  expect(footer.querySelectorAll("kbd")).toHaveLength(1);
  expect(footer.querySelector("kbd")?.textContent).toMatch(/^(Enter|⏎)$/);
  expect(footer.textContent).not.toContain("Start session");
  start().click();
  await vi.waitFor(() =>
    expectSubmit({
      message: "A mobile prompt",
      attachments: [expect.objectContaining(imageFields)],
    }),
  );
});

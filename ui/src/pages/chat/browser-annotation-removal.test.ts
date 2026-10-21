import { beforeEach, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { showToast, type ToastOptions } from "../../lib/toast.ts";
import { releaseChatAttachmentPayload } from "./attachment-payload-store.ts";
import { removeBrowserAnnotationWithUndo } from "./browser-annotation-removal.ts";

// mock-isolation: Observe Undo without registering a toast host or retaining attachment URLs.
vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));
// mock-isolation: Observe release without retaining shared attachment blobs and object URLs.
vi.mock("./attachment-payload-store.ts", () => ({ releaseChatAttachmentPayload: vi.fn() }));
const releasePayload = vi.mocked(releaseChatAttachmentPayload);
const labels = {
  removed: "Removed",
  undo: "Undo",
  undoUnavailable: "Remove another annotation before undoing",
};

function annotation(id: string): ChatAttachment {
  return {
    id,
    mimeType: "image/png",
    browserAnnotation: {
      modelContext: `Context ${id}`,
      title: `Title ${id}`,
      displayUrl: "example.com",
      markedRegionCount: 1,
      inspectedElement: false,
    },
  };
}
let target: ChatAttachment;
let state: { owner: object; sessionKey: string; attachments: ChatAttachment[] };
let host: Parameters<typeof removeBrowserAnnotationWithUndo>[0];
let toasts: ToastOptions[];
beforeEach(() => {
  target = annotation("target");
  state = { owner: {}, sessionKey: "agent:main", attachments: [target] };
  host = {
    getOwner: () => state.owner,
    getSessionKey: () => state.sessionKey,
    getAttachments: () => state.attachments,
    setAttachments: (next) => {
      state.attachments = next;
    },
    focusComposer: vi.fn(),
    focusRestoredAnnotation: vi.fn(),
  };
  toasts = [];
  releasePayload.mockClear();
  vi.mocked(showToast)
    .mockReset()
    .mockImplementation((options) => {
      toasts.push(options);
      return true;
    });
});
function remove() {
  return removeBrowserAnnotationWithUndo(host, target, labels);
}
function undo() {
  toasts[0]?.onDismiss?.("action");
  toasts[0]?.onAction?.();
}

it("preserves siblings and restores the complete package once at its original position", () => {
  const ordinary = { id: "ordinary", mimeType: "image/png" };
  const second = annotation("second");
  state.attachments = [ordinary, target, second];
  expect(remove()).toBe(true);
  expect(state.attachments).toEqual([ordinary, second]);
  undo();
  toasts[0]?.onAction?.();
  expect(state.attachments).toEqual([ordinary, target, second]);
  expect(host.focusRestoredAnnotation).toHaveBeenCalledOnce();
  expect(releasePayload).not.toHaveBeenCalled();
});

it("finalizes payload ownership once when Undo expires", () => {
  remove();
  toasts[0]?.onDismiss?.("timeout");
  toasts[0]?.onDismiss?.("timeout");
  expect(releasePayload).toHaveBeenCalledOnce();
  expect(state.attachments).toEqual([]);
});

it.each(["session", "composer owner"])("never restores into a replacement %s", (replacement) => {
  remove();
  if (replacement === "session") {
    state.sessionKey = "agent:other";
  } else {
    state.owner = {};
  }
  undo();
  expect(state.attachments).toEqual([]);
  expect(releasePayload).toHaveBeenCalledOnce();
  expect(host.focusRestoredAnnotation).not.toHaveBeenCalled();
});

it("releases instead of exceeding the bound when Undo follows a replacement", () => {
  state.attachments = [target, ...["second", "third", "fourth"].map(annotation)];
  remove();
  host.setAttachments([...state.attachments, annotation("replacement")]);
  undo();
  expect(state.attachments).toHaveLength(4);
  expect(state.attachments).not.toContain(target);
  expect(releasePayload).toHaveBeenCalledOnce();
  expect(toasts[1]?.message).toBe(labels.undoUnavailable);
});

it("releases immediately when no toast host can present Undo", () => {
  vi.mocked(showToast).mockReturnValue(false);
  remove();
  expect(releasePayload).toHaveBeenCalledOnce();
});

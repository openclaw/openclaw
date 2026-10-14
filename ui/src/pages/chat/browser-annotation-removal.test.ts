import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { showToast, type ToastOptions } from "../../lib/toast.ts";
import { releaseChatAttachmentPayload } from "./attachment-payload-store.ts";
import { removeBrowserAnnotationWithUndo } from "./browser-annotation-removal.ts";

// mock-isolation: Observe Undo callbacks without registering a toast host in shared DOM state.
vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));
// mock-isolation: Observe release without retaining shared attachment blobs and object URLs.
vi.mock("./attachment-payload-store.ts", () => ({ releaseChatAttachmentPayload: vi.fn() }));

const releasePayload = vi.mocked(releaseChatAttachmentPayload);
const presentToast = vi.mocked(showToast);

beforeEach(() => {
  releasePayload.mockClear();
  presentToast.mockReset();
});

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

function createHost(initial: ChatAttachment[]) {
  let owner = {};
  let sessionKey = "agent:main";
  let attachments = initial;
  return {
    host: {
      getOwner: () => owner,
      getSessionKey: () => sessionKey,
      getAttachments: () => attachments,
      setAttachments: (next: ChatAttachment[]) => {
        attachments = next;
      },
      requestUpdate: vi.fn(),
      focusComposer: vi.fn(),
      focusRestoredAnnotation: vi.fn(),
    },
    attachments: () => attachments,
    switchSession: (next: string) => {
      sessionKey = next;
    },
    replaceOwner: () => {
      owner = {};
    },
  };
}

describe("browser annotation removal", () => {
  it("preserves siblings and restores the complete package once at its original position", () => {
    const ordinary = { id: "ordinary", mimeType: "image/png" };
    const first = annotation("first");
    const second = annotation("second");
    const state = createHost([ordinary, first, second]);
    let toast: ToastOptions | undefined;
    presentToast.mockImplementation((options) => {
      toast = options;
      return true;
    });

    expect(removeBrowserAnnotationWithUndo(state.host, first, labels)).toBe(true);
    expect(state.attachments()).toEqual([ordinary, second]);

    toast?.onDismiss?.("action");
    toast?.onAction?.();
    toast?.onAction?.();

    expect(state.attachments()).toEqual([ordinary, first, second]);
    expect(state.host.focusRestoredAnnotation).toHaveBeenCalledOnce();
    expect(releasePayload).not.toHaveBeenCalled();
  });

  it("finalizes payload ownership once when Undo expires", () => {
    const target = annotation("target");
    const state = createHost([target]);
    let toast: ToastOptions | undefined;
    presentToast.mockImplementation((options) => {
      toast = options;
      return true;
    });
    removeBrowserAnnotationWithUndo(state.host, target, labels);

    toast?.onDismiss?.("timeout");
    toast?.onDismiss?.("timeout");

    expect(releasePayload).toHaveBeenCalledOnce();
    expect(state.attachments()).toEqual([]);
  });

  it.each(["session", "composer owner"])("never restores into a replacement %s", (replacement) => {
    const target = annotation("target");
    const state = createHost([target]);
    let toast: ToastOptions | undefined;
    presentToast.mockImplementation((options) => {
      toast = options;
      return true;
    });
    removeBrowserAnnotationWithUndo(state.host, target, labels);
    if (replacement === "session") {
      state.switchSession("agent:other");
    } else {
      state.replaceOwner();
    }

    toast?.onDismiss?.("action");
    toast?.onAction?.();

    expect(state.attachments()).toEqual([]);
    expect(releasePayload).toHaveBeenCalledOnce();
    expect(state.host.focusRestoredAnnotation).not.toHaveBeenCalled();
  });

  it("releases instead of exceeding the bound when Undo follows a replacement", () => {
    const target = annotation("target");
    const state = createHost([
      target,
      annotation("second"),
      annotation("third"),
      annotation("fourth"),
    ]);
    const toasts: ToastOptions[] = [];
    presentToast.mockImplementation((options) => {
      toasts.push(options);
      return true;
    });
    removeBrowserAnnotationWithUndo(state.host, target, labels);
    state.host.setAttachments([...state.attachments(), annotation("replacement")]);

    toasts[0]?.onDismiss?.("action");
    toasts[0]?.onAction?.();

    expect(state.attachments()).toHaveLength(4);
    expect(state.attachments()).not.toContain(target);
    expect(releasePayload).toHaveBeenCalledOnce();
    expect(toasts[1]?.message).toBe(labels.undoUnavailable);
  });

  it("releases immediately when no toast host can present Undo", () => {
    const target = annotation("target");
    const state = createHost([target]);
    presentToast.mockReturnValue(false);

    removeBrowserAnnotationWithUndo(state.host, target, labels);

    expect(releasePayload).toHaveBeenCalledOnce();
  });
});

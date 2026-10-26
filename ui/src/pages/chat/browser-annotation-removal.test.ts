/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { showToast, type ToastOptions } from "../../lib/toast.ts";
import { releaseChatAttachmentPayload } from "./attachment-payload-store.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";

// mock-isolation: Observe Undo without registering a toast host or retaining attachment URLs.
vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/toast.ts")>()),
  showToast: vi.fn(),
}));
// mock-isolation: Observe release without retaining shared attachment blobs and object URLs.
vi.mock("./attachment-payload-store.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./attachment-payload-store.ts")>()),
  releaseChatAttachmentPayload: vi.fn(),
}));
const releasePayload = vi.mocked(releaseChatAttachmentPayload);

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
let state: ReturnType<typeof createTestChatPane>["state"];
let pane: TestChatPane & {
  removeBrowserAnnotation: (attachment: ChatAttachment) => void;
  registerBrowserAnnotationFocus: (id: string, button: HTMLButtonElement) => () => void;
};
let restoredButton: HTMLButtonElement;
let restoredFocus: MockInstance<HTMLButtonElement["focus"]>;
let toasts: ToastOptions[];
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  target = annotation("target");
  const fixture = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  state = fixture.state;
  state.chatAttachments = [target];
  pane = fixture.pane as typeof pane;
  Object.assign(pane, { stagedAttachmentGatewayOwner: {} });
  vi.spyOn(pane, "awaitDomCommit").mockResolvedValue(true);
  restoredButton = document.createElement("button");
  restoredFocus = vi.spyOn(restoredButton, "focus");
  pane.registerBrowserAnnotationFocus(target.id, restoredButton);
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
  pane.removeBrowserAnnotation(target);
}
function undo() {
  toasts[0]?.onDismiss?.("action");
  toasts[0]?.onAction?.();
}

it("preserves siblings and restores the complete package once at its original position", async () => {
  const ordinary = { id: "ordinary", mimeType: "image/png" };
  const second = annotation("second");
  state.chatAttachments = [ordinary, target, second];
  remove();
  expect(state.chatAttachments).toEqual([ordinary, second]);
  undo();
  toasts[0]?.onAction?.();
  expect(state.chatAttachments).toEqual([ordinary, target, second]);
  expect(state.chatAttachments[1]).toBe(target);
  await Promise.resolve();
  expect(restoredFocus).toHaveBeenCalledOnce();
  expect(releasePayload).not.toHaveBeenCalled();
});

it("finalizes payload ownership once when Undo expires", () => {
  remove();
  toasts[0]?.onDismiss?.("timeout");
  toasts[0]?.onDismiss?.("timeout");
  expect(releasePayload).toHaveBeenCalledOnce();
  expect(state.chatAttachments).toEqual([]);
});

it.each(["session", "composer owner"])(
  "never restores into a replacement %s",
  async (replacement) => {
    remove();
    if (replacement === "session") {
      state.sessionKey = "agent:other";
    } else {
      Object.assign(pane, { stagedAttachmentGatewayOwner: {} });
    }
    undo();
    expect(state.chatAttachments).toEqual([]);
    expect(releasePayload).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(restoredFocus).not.toHaveBeenCalled();
  },
);

it("releases instead of exceeding the bound when Undo follows a replacement", () => {
  state.chatAttachments = [target, ...["second", "third", "fourth"].map(annotation)];
  remove();
  state.chatAttachments = [...state.chatAttachments, annotation("replacement")];
  undo();
  expect(state.chatAttachments).toHaveLength(4);
  expect(state.chatAttachments).not.toContain(target);
  expect(releasePayload).toHaveBeenCalledOnce();
  expect(toasts[1]?.message).toBe(
    "Undo is unavailable because the browser annotation limit has been reached.",
  );
});

it("releases immediately when no toast host can present Undo", () => {
  vi.mocked(showToast).mockReturnValue(false);
  remove();
  expect(releasePayload).toHaveBeenCalledOnce();
});

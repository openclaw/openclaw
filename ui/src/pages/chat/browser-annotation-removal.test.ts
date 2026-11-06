/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import * as toast from "../../lib/toast.ts";
import type { ToastOptions } from "../../lib/toast.ts";
import * as payloads from "./attachment-payload-store.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";

const annotation = (id: string): ChatAttachment => ({
  id,
  mimeType: "image/png",
  browserAnnotation: {
    modelContext: `Context ${id}`,
    title: `Title ${id}`,
    displayUrl: "example.com",
    markedRegionCount: 1,
    inspectedElement: false,
  },
});
let target: ChatAttachment;
let state: ReturnType<typeof createTestChatPane>["state"];
let pane: TestChatPane & {
  removeBrowserAnnotation: (attachment: ChatAttachment) => void;
  registerBrowserAnnotationFocus: (id: string, button: HTMLButtonElement) => () => void;
};
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
  const restoredButton = document.createElement("button");
  restoredFocus = vi.spyOn(restoredButton, "focus");
  pane.registerBrowserAnnotationFocus(target.id, restoredButton);
  toasts = [];
  vi.spyOn(payloads, "releaseChatAttachmentPayload").mockImplementation(() => {});
  vi.spyOn(toast, "showToast").mockImplementation((options) => {
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
  expect(payloads.releaseChatAttachmentPayload).not.toHaveBeenCalled();
});

it.each(["expires", "cannot be presented"])("releases once when Undo %s", (reason) => {
  if (reason === "cannot be presented") {
    vi.mocked(toast.showToast).mockReturnValue(false);
  }
  remove();
  toasts[0]?.onDismiss?.("timeout");
  toasts[0]?.onDismiss?.("timeout");
  expect(payloads.releaseChatAttachmentPayload).toHaveBeenCalledOnce();
  expect(state.chatAttachments).toEqual([]);
});

it("never restores into a replacement session", async () => {
  remove();
  state.sessionKey = "agent:other";
  undo();
  expect(state.chatAttachments).toEqual([]);
  expect(payloads.releaseChatAttachmentPayload).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(restoredFocus).not.toHaveBeenCalled();
});

it("releases instead of exceeding the bound when Undo follows a replacement", () => {
  state.chatAttachments = [target, ...["second", "third", "fourth"].map(annotation)];
  remove();
  state.chatAttachments = [...state.chatAttachments, annotation("replacement")];
  undo();
  expect(state.chatAttachments).toHaveLength(4);
  expect(state.chatAttachments).not.toContain(target);
  expect(payloads.releaseChatAttachmentPayload).toHaveBeenCalledOnce();
});

/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { showChatAnnotationEditor, removeChatSelectionPopup } from "./chat-selection-popup.tsx";

const moduleLoad = vi.hoisted(() => Promise.withResolvers<void>());
vi.mock("./chat-annotation-editor.tsx", async (importOriginal) => {
  await moduleLoad.promise;
  return importOriginal();
});

afterEach(() => {
  moduleLoad.resolve();
  removeChatSelectionPopup();
  document.body.replaceChildren();
});

it("keeps a dismissed pending annotation closed and focuses the next admitted editor", async () => {
  const options = {
    paneId: "pane-a",
    anchorRect: new DOMRect(100, 100, 120, 20),
    comment: "A draft comment",
    onSave: vi.fn(),
    onCancel: vi.fn(),
  };
  const pending = showChatAnnotationEditor(options, () => true);
  expect(document.querySelector(".chat-annotation-editor")).toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(options.onCancel).toHaveBeenCalledOnce();
  const scrolled = showChatAnnotationEditor(options, () => true);
  document.dispatchEvent(new Event("scroll"));
  moduleLoad.resolve();
  await Promise.all([pending, scrolled]);
  expect(document.querySelector(".chat-annotation-editor")).toBeNull();

  await showChatAnnotationEditor(options, () => true);
  const input = document.querySelector(".chat-annotation-editor textarea");
  expect(input).not.toBeNull();
  expect(document.activeElement).toBe(input);
  expect(options.onSave).not.toHaveBeenCalled();
});

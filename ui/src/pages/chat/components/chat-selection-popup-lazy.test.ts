/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { handleChatSelectionPointerUp, removeChatSelectionPopup } from "./chat-selection-popup.tsx";

const toolbarModule = vi.hoisted(() => ({
  load: Promise.withResolvers<void>(),
  requested: Promise.withResolvers<void>(),
}));
// mock-isolation: Hold the real optional view import until its owning pane retires.
vi.mock("./chat-selection-popup-view.tsx", async (importOriginal) => {
  toolbarModule.requested.resolve();
  await toolbarModule.load.promise;
  return importOriginal();
});

afterEach(() => {
  toolbarModule.load.resolve();
  removeChatSelectionPopup();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

it("keeps a retired selection closed when its toolbar import settles", async ({
  onTestFinished,
}) => {
  onTestFinished(() => toolbarModule.load.resolve());
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(100, 100, 120, 20),
  });
  onTestFinished(() => {
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  });
  const thread = document.body.appendChild(document.createElement("div"));
  thread.innerHTML = '<div class="chat-bubble" data-message-id="selected">Selected passage</div>';
  const range = document.createRange();
  range.selectNodeContents(thread.firstElementChild!);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  const onAskSideChat = vi.fn();
  const open = () =>
    handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
      paneId: "retired-pane",
      onAskSideChat,
      onAskNewSession: vi.fn(),
    });
  open();
  await toolbarModule.requested.promise;
  removeChatSelectionPopup("retired-pane");
  toolbarModule.load.resolve();
  await vi.dynamicImportSettled();
  expect(document.querySelector(".chat-selection-popup")).toBeNull();
  open();
  await waitForSolid(() =>
    expect(document.querySelector(".chat-selection-popup button")).not.toBeNull(),
  );
  document.querySelector<HTMLButtonElement>(".chat-selection-popup button")!.click();
  expect(onAskSideChat).toHaveBeenCalledExactlyOnceWith(
    { text: "Selected passage", start: 0, end: 16, messageId: "selected" },
    expect.objectContaining({ top: 100, left: 100 }),
  );
});

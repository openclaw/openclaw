/* @vitest-environment jsdom */
import "../../lib/toast-host.tsx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatInto, renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

let toastHost: HTMLElementTagNameMap["openclaw-toast-host"];
beforeEach(() => {
  installTranscriptDomMocks();
  toastHost = document.body.appendChild(document.createElement("openclaw-toast-host"));
});
afterEach(() => {
  toastHost.remove();
  resetChatViewState();
  resetTranscriptTestDom();
});

it("refuses suggestion files at picker, paste and drop while preserving native text input", async () => {
  const onAttachmentsChange = vi.fn();
  const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
  const container = renderChatView({ suggestionComposer: true, onAttachmentsChange });
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(
    container.querySelector<HTMLButtonElement>(".agent-chat__input-btn--attach")?.disabled,
  ).toBe(true);
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')].every(
      (file) => file.disabled,
    ),
  ).toBe(true);
  const file = new File(["image"], "picture.png", { type: "image/png" });
  const transfer = {
    types: ["Files"],
    files: [file],
    items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    getData: () => "",
    dropEffect: "copy",
  };
  for (const type of ["paste", "dragenter", "dragover", "drop"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
      value: transfer,
    });
    input.dispatchEvent(event);
    if (type !== "dragenter") {
      expect(event.defaultPrevented).toBe(true);
    }
  }
  await toastHost.updateComplete;
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(toastHost.querySelector('[role="alert"]')?.textContent).toContain(
      "Suggestions are text only.",
    ),
  );
  expect(transfer.dropEffect).toBe("none");
  expect(container.querySelector("[data-attachment-drop-active]")).toBeNull();
  expect(read).not.toHaveBeenCalled();
  expect(onAttachmentsChange).not.toHaveBeenCalled();
  const text = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(text, "clipboardData", {
    value: {
      files: [],
      items: [],
      getData: (type: string) => (type === "text/plain" ? "text".repeat(300) : ""),
    },
  });
  input.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  expect(onAttachmentsChange).not.toHaveBeenCalled();

  renderChatInto(container, { suggestionComposer: false, onAttachmentsChange });
  expect(
    container.querySelector<HTMLButtonElement>(".agent-chat__input-btn--attach")?.disabled,
  ).toBe(false);
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')].every(
      (control) => !control.disabled,
    ),
  ).toBe(true);
});

/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  adoptBootComposer,
  bootComposerElement,
  retireBootComposer,
  settleBootComposer,
  takeBootComposer,
} from "./boot-composer.ts";
import { canReloadControlUiDocument } from "./document-reload-guard.ts";

function bootDocument(chat = true) {
  document.documentElement.toggleAttribute("data-openclaw-boot-chat", chat);
  document.body.innerHTML =
    '<main id="frame"><textarea id="openclaw-boot-composer"></textarea></main><div id="next"></div>';
  return document.getElementById("openclaw-boot-composer") as HTMLTextAreaElement;
}

afterEach(() => {
  retireBootComposer();
  document.documentElement.removeAttribute("data-openclaw-boot-chat");
  document.body.replaceChildren();
});

describe("boot composer", () => {
  it("carries the static composer through a frame swap and hands it to one pane", () => {
    const textarea = bootDocument();
    textarea.value = "Ship it";
    textarea.setAttribute("data-submit-queued", "");
    textarea.setAttribute("data-focused", "");
    textarea.focus();
    adoptBootComposer(true);
    expect(canReloadControlUiDocument()).toBe(false);

    document.getElementById("frame")!.remove();
    expect(document.activeElement).not.toBe(textarea);
    document.getElementById("next")!.append(bootComposerElement()!);
    settleBootComposer();
    expect(document.activeElement).toBe(textarea);

    textarea.setSelectionRange(2, 4, "backward");
    expect(takeBootComposer()).toEqual({
      text: "Ship it",
      submit: true,
      focused: true,
      selection: [2, 4, "backward"],
      scroll: [0, 0],
    });
    expect(textarea.isConnected).toBe(false);
    expect(takeBootComposer()).toBeNull();
    expect(canReloadControlUiDocument()).toBe(true);
  });

  it("captures the connected viewport before a frame move without waiting for scroll events", () => {
    const textarea = bootDocument();
    textarea.value = "First line\nSecond line\nThird line";
    textarea.setAttribute("data-focused", "");
    textarea.scrollLeft = 11;
    textarea.scrollTop = 43;
    adoptBootComposer(true);

    // A native scroll event can still be queued when the next frame takes the editor.
    textarea.scrollLeft = 17;
    textarea.scrollTop = 67;
    const moving = bootComposerElement()!;
    document.getElementById("frame")!.remove();
    textarea.scrollLeft = 0;
    textarea.scrollTop = 0;
    expect(bootComposerElement()).toBe(moving);
    document.getElementById("next")!.append(moving);
    settleBootComposer();
    expect([textarea.scrollLeft, textarea.scrollTop]).toEqual([17, 67]);
    expect(document.activeElement).toBe(textarea);

    document.getElementById("next")!.remove();
    textarea.scrollLeft = 0;
    textarea.scrollTop = 0;
    expect(bootComposerElement()).toBe(textarea);
    expect(takeBootComposer()?.scroll).toEqual([17, 67]);
  });

  it("protects current text until cleared and releases browser protection when retired", () => {
    const textarea = bootDocument();
    adoptBootComposer(true);
    expect(canReloadControlUiDocument()).toBe(true);
    textarea.value = "Keep this early input";
    expect(canReloadControlUiDocument(true)).toBe(false);
    expect(document.activeElement).toBe(textarea);
    const blocked = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    textarea.value = "";
    expect(canReloadControlUiDocument()).toBe(true);
    textarea.value = "Retired with its linked session";
    retireBootComposer();
    expect(canReloadControlUiDocument()).toBe(true);
    const retired = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(retired);
    expect(retired.defaultPrevented).toBe(false);
  });

  it("does not steal focus the operator moved elsewhere", () => {
    const textarea = bootDocument();
    adoptBootComposer(true);
    settleBootComposer();
    expect(document.activeElement).not.toBe(textarea);
    expect(takeBootComposer()).toMatchObject({ text: "", submit: false, focused: false });
  });

  it("discards early input when history leaves the linked session", () => {
    const textarea = bootDocument();
    adoptBootComposer(true);
    textarea.value = "Not for the next page";
    expect(canReloadControlUiDocument()).toBe(false);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(textarea.isConnected).toBe(false);
    expect(takeBootComposer()).toBeNull();
    expect(canReloadControlUiDocument()).toBe(true);
  });

  it.each([
    { name: "outside chat routes", chat: false, application: true },
    { name: "in document views", chat: true, application: false },
  ])("removes the frame's composer $name", ({ chat, application }) => {
    const textarea = bootDocument(chat);
    adoptBootComposer(application);
    expect(textarea.isConnected).toBe(false);
    expect(bootComposerElement()).toBeNull();
  });
});

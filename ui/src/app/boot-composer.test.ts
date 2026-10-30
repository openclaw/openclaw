/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  adoptBootComposer,
  bootComposerElement,
  retireBootComposer,
  settleBootComposer,
  takeBootComposer,
} from "./boot-composer.ts";

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
    });
    expect(textarea.isConnected).toBe(false);
    expect(takeBootComposer()).toBeNull();
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
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(textarea.isConnected).toBe(false);
    expect(takeBootComposer()).toBeNull();
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

// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createChatProps, disposeChatView, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const containers: HTMLElement[] = [];

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  installTranscriptDomMocks();
});

afterEach(() => {
  for (const container of containers.splice(0)) {
    disposeChatView(container);
  }
  resetChatViewState();
  resetTranscriptTestDom();
});

function createPane(paneId = "primary") {
  const container = createComposerContainer();
  containers.push(container);
  document.body.append(container);
  const onClearReply = vi.fn();
  const onAbort = vi.fn();
  const props = createChatProps({
    paneId,
    sessionKey: `agent:main:${paneId}`,
    replyTarget: { messageId: "quoted-message", text: "Keep this reply", senderLabel: "User" },
    canAbort: true,
    runActive: true,
    onClearReply,
    onAbort,
  });
  renderChatPropsInto(container, props);
  const composer = expectDefined(
    container.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea"),
    "composer",
  );
  const search = () =>
    expectDefined(
      container.querySelector<HTMLInputElement>(".agent-chat__search-bar input"),
      "search",
    );
  async function openSearch(query: string | null = "unmatched query") {
    composer.focus();
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await waitForSolid(() => expect(document.activeElement).toBe(search()));
    if (query !== null) {
      search().value = query;
      search().dispatchEvent(new Event("input", { bubbles: true }));
    }
    return search();
  }
  return { container, composer, search, openSearch, onClearReply, onAbort };
}

function escape() {
  return new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
}

describe("transcript search Escape", () => {
  it("returns to the composer when the shortcut origin has been removed", async () => {
    const pane = createPane();
    const chat = expectDefined(pane.container.querySelector(".chat"), "chat shortcut owner");
    const trigger = chat.appendChild(document.createElement("button"));
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await waitForSolid(() => expect(document.activeElement).toBe(pane.search()));
    trigger.remove();
    pane.search().dispatchEvent(escape());
    await waitForSolid(() => expect(document.activeElement).toBe(pane.composer));
    expect(pane.onClearReply).not.toHaveBeenCalled();
    expect(pane.onAbort).not.toHaveBeenCalled();
  });

  it("closes from the search button after its tooltip and restores focus without clearing reply or stopping", async () => {
    const pane = createPane();
    await pane.openSearch();
    const target = expectDefined(
      pane.container.querySelector<HTMLElement>(".agent-chat__search-bar button"),
      "search control",
    );
    target.focus();
    const tooltip = expectDefined(target.closest("openclaw-tooltip"), "search tooltip");
    await tooltip.updateComplete;
    expect(tooltip.hasAttribute("open")).toBe(true);
    // Its focused tooltip owns the first Escape, before search receives it.
    target.dispatchEvent(escape());
    await Promise.resolve();
    expect(pane.search().value).toBe("unmatched query");
    expect(pane.onClearReply).not.toHaveBeenCalled();
    const event = escape();
    target.dispatchEvent(event);
    await Promise.resolve();

    expect(pane.container.querySelector(".agent-chat__search-bar")).toBeNull();
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pane.composer);
    expect(pane.onClearReply).not.toHaveBeenCalled();
    expect(pane.onAbort).not.toHaveBeenCalled();
    await pane.openSearch(null);
    expect(pane.search().value).toBe("");
  });
});

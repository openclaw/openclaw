// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { getComposerTextarea, renderChatInto } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  installTranscriptDomMocks();
});

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

function createPane() {
  const container = createComposerContainer();
  document.body.append(container);
  const onClearReply = vi.fn();
  const onAbort = vi.fn();
  renderChatInto(container, {
    paneId: "primary",
    sessionKey: "agent:main:primary",
    replyTarget: { messageId: "quoted-message", text: "Keep this reply", senderLabel: "User" },
    canAbort: true,
    runActive: true,
    onClearReply,
    onAbort,
  });
  const composer = getComposerTextarea(container);
  const search = () =>
    expectDefined(
      container.querySelector<HTMLInputElement>(".agent-chat__search-bar input"),
      "search",
    );
  async function openSearch(query?: string, origin: HTMLElement = composer) {
    origin.focus();
    origin.dispatchEvent(key("f", true));
    await waitForSolid(() => expect(document.activeElement).toBe(search()));
    if (query !== undefined) {
      search().value = query;
      search().dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  return { container, composer, search, openSearch, onClearReply, onAbort };
}

const key = (value: string, ctrlKey = false) =>
  new KeyboardEvent("keydown", { key: value, ctrlKey, bubbles: true, cancelable: true });
const escape = () => key("Escape");

it("returns to the composer when the shortcut origin has been removed", async () => {
  const pane = createPane();
  const chat = expectDefined(pane.container.querySelector(".chat"), "chat shortcut owner");
  const trigger = chat.appendChild(document.createElement("button"));
  await pane.openSearch(undefined, trigger);
  trigger.remove();
  pane.search().dispatchEvent(escape());
  await waitForSolid(() => expect(document.activeElement).toBe(pane.composer));
  expect(pane.onClearReply).not.toHaveBeenCalled();
  expect(pane.onAbort).not.toHaveBeenCalled();
});

it("closes from the search button after its tooltip and restores focus without clearing reply or stopping", async () => {
  const pane = createPane();
  await pane.openSearch("unmatched query");
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
  await pane.openSearch();
  expect(pane.search().value).toBe("");
});

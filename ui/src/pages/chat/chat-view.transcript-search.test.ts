// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { getComposerTextarea, renderChatInto } from "./chat-view.test-helpers.ts";
import {
  resetTranscriptSession,
  toggleTranscriptSearch,
} from "./components/chat-thread-interactions.ts";
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
    flush();
    await vi.dynamicImportSettled();
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

describe("per-pane chat presentation state", () => {
  it.each(["MacIntel"])(
    "uses the platform search shortcut on %s without consuming text navigation",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const primary = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
      const other = platform === "MacIntel" ? { ctrlKey: true } : { metaKey: true };
      const container = createComposerContainer();
      document.body.append(container);
      try {
        renderChatInto(container);
        const composer = getComposerTextarea(container);
        composer.focus();
        for (const character of ["f", "а"]) {
          const navigationEvent = new KeyboardEvent("keydown", {
            key: character,
            code: "KeyF",
            ...other,
            bubbles: true,
            cancelable: true,
          });
          composer.dispatchEvent(navigationEvent);
          expect(navigationEvent.defaultPrevented).toBe(false);
          expect(container.querySelector(".agent-chat__search-bar")).toBeNull();
          expect(document.activeElement).toBe(composer);
          const event = new KeyboardEvent("keydown", {
            key: character,
            code: "KeyF",
            ...primary,
            bubbles: true,
            cancelable: true,
          });

          composer.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(true);
          flush();
          await vi.dynamicImportSettled();
          await waitForSolid(() =>
            expect(document.activeElement).toBe(
              container.querySelector<HTMLInputElement>(
                '.agent-chat__search-bar input[type="text"]',
              ),
            ),
          );

          const closeEvent = new KeyboardEvent("keydown", {
            key: character,
            code: "KeyF",
            ...primary,
            bubbles: true,
            cancelable: true,
          });
          document.activeElement?.dispatchEvent(closeEvent);
          expect(closeEvent.defaultPrevented).toBe(true);
          await waitForSolid(() => {
            expect(document.activeElement).toBe(composer);
            expect(container.querySelector(".agent-chat__search-bar")).toBeNull();
          });
          expect(getComposerTextarea(container)).toBe(composer);
        }
      } finally {
        container.remove();
      }
    },
  );

  it("returns focus to the composer when the original target disappears", async () => {
    const container = createComposerContainer();
    document.body.append(container);
    try {
      renderChatInto(container);
      const composer = getComposerTextarea(container);
      const transientTarget = document.createElement("button");
      const chat = container.querySelector<HTMLElement>(".chat");
      if (!chat) {
        throw new Error("expected chat section");
      }
      chat.append(transientTarget);
      transientTarget.focus();

      transientTarget.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      flush();
      await vi.dynamicImportSettled();
      await waitForSolid(() =>
        expect(document.activeElement).toBe(
          container.querySelector('.agent-chat__search-bar input[type="text"]'),
        ),
      );

      transientTarget.remove();
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForSolid(() => expect(document.activeElement).toBe(composer));
      expect(container.querySelector(".agent-chat__search-bar")).toBeNull();
      expect(getComposerTextarea(container)).toBe(composer);
    } finally {
      container.remove();
    }
  });

  it("keeps search state and resets scoped to its pane", async () => {
    const paneA = createComposerContainer();
    const paneB = createComposerContainer();
    const selector = ".agent-chat__search-bar";
    const renderPane = (container: HTMLElement, paneId: string) =>
      renderChatInto(container, { paneId, draft: "", getDraft: () => "" });
    const open = async (container: HTMLElement, paneId: string) => {
      toggleTranscriptSearch(paneId);
      renderPane(container, paneId);
      await vi.dynamicImportSettled();
    };
    renderPane(paneA, "pane-a");
    renderPane(paneB, "pane-b");
    await open(paneA, "pane-a");
    expect(paneA.querySelector(selector)).not.toBeNull();
    expect(paneB.querySelector(selector)).toBeNull();
    await open(paneB, "pane-b");
    resetTranscriptSession("pane-a");
    renderPane(paneA, "pane-a");
    renderPane(paneB, "pane-b");
    expect(paneA.querySelector(selector)).toBeNull();
    expect(paneB.querySelector(selector)).not.toBeNull();
  });
});

import { expectDefined } from "@openclaw/normalization-core";
// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerEditor } from "../../components/composer-editor.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
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
    render(null, container);
  }
  resetChatViewState();
  resetTranscriptTestDom();
});

function createPane(paneId = "primary") {
  const container = document.createElement("div");
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
    onRequestUpdate: () => render(renderChat(props), container),
  });
  render(renderChat(props), container);
  const composer = expectDefined(
    container.querySelector<ComposerEditor>(
      ".agent-chat__composer-combobox > openclaw-composer-editor",
    ),
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
    await Promise.resolve();
    expect(document.activeElement).toBe(search());
    if (query !== null) {
      search().value = query;
      search().dispatchEvent(new Event("input", { bubbles: true }));
    }
    return search();
  }
  return { container, composer, search, openSearch, onClearReply, onAbort };
}

function escape(options: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

describe("transcript search Escape", () => {
  it.each(["input", "button"])(
    "closes from the search %s, resets the query, and restores focus without clearing reply or stopping",
    async (control) => {
      const pane = createPane();
      await pane.openSearch();
      const target = expectDefined(
        pane.container.querySelector<HTMLElement>(`.agent-chat__search-bar ${control}`),
        "search control",
      );
      target.focus();
      if (control === "button") {
        // Its focused tooltip owns the first Escape, before search receives it.
        target.dispatchEvent(escape());
        await Promise.resolve();
        expect(pane.search().value).toBe("unmatched query");
        expect(pane.onClearReply).not.toHaveBeenCalled();
      }
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
    },
  );

  it.each([{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }])(
    "leaves an IME-owned or already handled Escape alone: %j",
    async (options) => {
      const pane = createPane();
      const input = await pane.openSearch();
      const event = escape("defaultPrevented" in options ? {} : options);
      if ("defaultPrevented" in options) {
        event.preventDefault();
      }
      input.dispatchEvent(event);
      await Promise.resolve();

      expect(pane.search().value).toBe("unmatched query");
      expect(document.activeElement).toBe(input);
      expect(pane.onClearReply).not.toHaveBeenCalled();
      expect(pane.onAbort).not.toHaveBeenCalled();
    },
  );

  it("closes only the focused pane's search", async () => {
    const first = createPane("first");
    const second = createPane("second");
    await first.openSearch("first query");
    await second.openSearch("second query");
    first.search().focus();
    first.search().dispatchEvent(escape());
    await Promise.resolve();

    expect(first.container.querySelector(".agent-chat__search-bar")).toBeNull();
    expect(second.search().value).toBe("second query");
    expect(document.activeElement).toBe(first.composer);
    expect(first.onClearReply).not.toHaveBeenCalled();
    expect(second.onClearReply).not.toHaveBeenCalled();
  });
});

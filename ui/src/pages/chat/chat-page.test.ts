/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./chat-pane.ts", () => {
  if (!customElements.get("openclaw-chat-pane")) {
    customElements.define("openclaw-chat-pane", class extends HTMLElement {});
  }
  return {};
});

import type { ResizableDivider } from "../../components/resizable-divider.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ChatPage } from "./chat-page.ts";
import { createSplitLayout, type ChatSplitLayout } from "./split-layout.ts";

type RenderedPane = HTMLElement & {
  paneId: string;
  sessionKey: string;
  active: boolean;
  chrome: "none" | "pane";
};

function setLayout(page: ChatPage, layout: ChatSplitLayout | undefined) {
  (page as unknown as { layout: ChatSplitLayout | undefined }).layout = layout;
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches,
      media: "(max-width: 1099px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("chat page split layout host", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.clear();
    stubMatchMedia(false);
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders one chrome-free active pane in classic mode", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main", draft: "hello" };
    document.body.append(page);
    await page.updateComplete;

    const panes = page.querySelectorAll<RenderedPane>("openclaw-chat-pane");
    expect(panes).toHaveLength(1);
    expect(panes[0].paneId).toBe("single");
    expect(panes[0].sessionKey).toBe("main");
    expect(panes[0].active).toBe(true);
    expect(panes[0].chrome).toBe("none");
    expect(page.querySelector("resizable-divider")).toBeNull();
  });

  it("passes an empty session key while route data is still unresolved", async () => {
    // Regression: a fabricated fallback key here made the pane canonicalize
    // against it and skip gateway startup entirely (chat.startup never sent).
    const page = new ChatPage();
    document.body.append(page);
    await page.updateComplete;

    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    expect(pane?.sessionKey).toBe("");
    expect(pane?.active).toBe(true);
  });

  it("renders keyed panes and a divider for a two-column split", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;

    const panes = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
    const dividers = page.querySelectorAll<ResizableDivider>("resizable-divider");
    expect(panes.map((pane) => pane.paneId)).toEqual(["p1", "p2"]);
    expect(panes.map((pane) => pane.chrome)).toEqual(["pane", "pane"]);
    expect(panes.map((pane) => pane.active)).toEqual([false, true]);
    expect(dividers).toHaveLength(1);
    expect(dividers[0].orientation).toBe("vertical");
  });

  it("renders only the active pane from a preserved split on narrow viewports", async () => {
    stubMatchMedia(true);
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;

    const panes = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
    expect(panes.map((pane) => pane.paneId)).toEqual(["p2"]);
    expect(panes[0].active).toBe(true);
    expect(panes[0].chrome).toBe("pane");
    expect(page.querySelector("resizable-divider")).toBeNull();
  });
});

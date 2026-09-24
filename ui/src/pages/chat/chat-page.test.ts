/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page.test/"} */

import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import type { RouteLocation } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep this complete mock in the dedicated unit-mock-registry project.
vi.mock("./chat-pane.ts", () => ({}));

import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings } from "../../app/settings.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import {
  buildCatalogSessionKey,
  catalogSessionSearch,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createSplitLayout,
  setLayout,
  setNavigationContext,
  setViewerPresenceContext,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";
import { loadChatRoute } from "./route-loader.ts";

const WORK_SESSION_KEY = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const SESSION_VIEWERS_SET_METHOD = "sessions.viewers.set";
const CATALOG_KEY = {
  catalogId: "claude",
  hostId: "gateway:local",
  threadId: "thread-1",
} satisfies CatalogSessionKey;
const CATALOG_SESSION_KEY = buildCatalogSessionKey(CATALOG_KEY, "research");
const sessionPath = (sessionKey: string) =>
  sessionNavigationTarget({ face: "chat", sessionKey, fallbackAgentId: "main" }).options.pathname;
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SplitDropZone } from "./split-drop-zone.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { setPaneSession } from "./split-layout.ts";

type RenderedPane = HTMLElement & {
  paneId: string;
  focusComposer: boolean;
  chatMessagesBySession: ChatMessageCache;
  sessionKey: string;
  presented: boolean;
  active: boolean;
  paneTitle: string;
  narrow: boolean;
  mergedChrome: boolean;
  onOpenSplitView?: () => void;
  onFocusPane?: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
  onFaceChange?: (paneId: string, sessionKey: string, face: "chat" | "dashboard") => void;
  captureNavigationFace?: () => "chat" | "dashboard";
};

type RenderedDivider = HTMLElement & { orientation: "horizontal" | "vertical" };

function itemAt<T>(items: ArrayLike<T>, index: number, label: string): T {
  return expectDefined(items[index], `${label} ${index}`);
}

function getLayout(page: ChatPage): ChatSplitLayout | undefined {
  return (page as unknown as { layout: ChatSplitLayout | undefined }).layout;
}

function setNarrow(page: ChatPage, narrow: boolean) {
  (page as unknown as { narrow: boolean }).narrow = narrow;
  page.requestUpdate();
}

function applySessionDrop(page: ChatPage, sessionKey: string, paneId: string, zone: SplitDropZone) {
  (
    page as unknown as {
      applySessionDrop: (sessionKey: string, paneId: string, zone: SplitDropZone) => void;
    }
  ).applySessionDrop(sessionKey, paneId, zone);
}

function handleDrop(page: ChatPage, event: DragEvent) {
  (page as unknown as { handleDrop: (event: DragEvent) => void }).handleDrop(event);
}

function handleDragOver(page: ChatPage, event: DragEvent) {
  (page as unknown as { handleDragOver: (event: DragEvent) => void }).handleDragOver(event);
}

function getDropIndicator(page: ChatPage) {
  return (
    page as unknown as {
      dropIndicator: { paneId: string; zone: SplitDropZone } | null;
    }
  ).dropIndicator;
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

  it("selects the path agent for a synthetic catalog session", () => {
    const page = new ChatPage();
    const { setAgent } = setNavigationContext(page);
    page.data = {
      sessionKey: CATALOG_SESSION_KEY,
      agentId: "research",
    };

    document.body.append(page);

    expect(setAgent).toHaveBeenCalledWith("research", { background: true });
  });

  it("renders one chrome-free active pane in classic mode", async () => {
    const page = new ChatPage();
    setNavigationContext(page);
    page.data = { sessionKey: "main", draft: "hello" };
    document.body.append(page);
    await page.updateComplete;

    const panes = page.querySelectorAll<RenderedPane>("openclaw-chat-pane");
    expect(panes).toHaveLength(1);
    expect(itemAt(panes, 0, "rendered pane").paneId).toBe("p1");
    expect(itemAt(panes, 0, "rendered pane").sessionKey).toBe("main");
    expect(itemAt(panes, 0, "rendered pane").active).toBe(true);
    expect(itemAt(panes, 0, "rendered pane").mergedChrome).toBe(false);
    expect(itemAt(panes, 0, "rendered pane").classList.contains("chat-split-view__pane")).toBe(
      false,
    );
    expect(page.querySelector("resizable-divider")).toBeNull();
    expect(typeof itemAt(panes, 0, "rendered pane").onOpenSplitView).toBe("function");
  });

  it("passes merged chrome from the shared mobile-nav query", async () => {
    stubMatchMedia(true);
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await page.updateComplete;

    const pane = itemAt(page.querySelectorAll<RenderedPane>("openclaw-chat-pane"), 0, "pane");
    expect(pane.mergedChrome).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 1099px)");
    expect(matchMedia).toHaveBeenCalledWith(
      "(max-width: 900px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
    );
  });

  it("retains the classic pane element while split view opens and closes", async () => {
    const page = new ChatPage();
    setNavigationContext(page);
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await page.updateComplete;

    const classicPane = itemAt(
      page.querySelectorAll<RenderedPane>("openclaw-chat-pane"),
      0,
      "classic pane",
    );
    classicPane.onOpenSplitView?.();
    await page.updateComplete;

    const splitPanes = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
    expect(splitPanes).toHaveLength(2);
    expect(splitPanes[0]).toBe(classicPane);
    expect(classicPane.classList.contains("chat-split-view__pane")).toBe(true);
    const addedPane = itemAt(splitPanes, 1, "added split pane");
    addedPane.onClosePane?.(addedPane.paneId);
    await page.updateComplete;

    const survivingPane = itemAt(
      page.querySelectorAll<RenderedPane>("openclaw-chat-pane"),
      0,
      "surviving pane",
    );
    expect(survivingPane).toBe(classicPane);
    expect(survivingPane.classList.contains("chat-split-view__pane")).toBe(false);
  });

  it.each([
    "close",
    "alias",
    "background",
    "focus-moved",
    "navigation",
    "suspended",
    "teardown",
  ] as const)(
    "restores close focus only while its presentation still owns the intent (%s)",
    async (scenario) => {
      const page = new ChatPage();
      setNavigationContext(page);
      page.data = { sessionKey: "main" };
      document.body.append(page);
      await page.updateComplete;
      const original = itemAt(page.querySelectorAll<RenderedPane>("openclaw-chat-pane"), 0, "pane");
      original.onOpenSplitView?.();
      await page.updateComplete;
      const added = itemAt(page.querySelectorAll<RenderedPane>("openclaw-chat-pane"), 1, "pane");
      if (scenario === "alias") {
        const layout = expectDefined(getLayout(page), "split layout");
        setLayout(page, setPaneSession(layout, original.paneId, "agent:main:main"));
        await page.updateComplete;
        expect(original.sessionKey).toBe("main");
      }
      const header = original.appendChild(document.createElement("div"));
      header.className = "chat-pane__header";
      header.tabIndex = -1;
      const button = added.appendChild(document.createElement("button"));
      const outside = document.body.appendChild(document.createElement("button"));
      const teardown = createDeferred();
      if (scenario === "teardown") {
        added.append(
          Object.assign(document.createElement("mcp-app-view"), {
            teardown: () => teardown.promise,
            restartAfterTeardown: () => undefined,
          }),
        );
      }
      (scenario === "background" ? outside : button).focus();
      const href = window.location.href;
      try {
        added.onClosePane?.(added.paneId);
        if (scenario === "focus-moved") {
          outside.focus();
          outside.blur();
        } else if (scenario === "navigation") {
          window.history.replaceState(null, "", "/settings");
        } else if (scenario === "suspended") {
          page.presented = false;
        }
        await page.updateComplete;
        if (scenario === "teardown") {
          expect(document.activeElement).toBe(button);
          teardown.resolve();
          await vi.waitFor(() => expect(document.activeElement).toBe(header));
        } else if (scenario === "close" || scenario === "alias") {
          expect(document.activeElement).toBe(header);
        } else {
          expect(document.activeElement).not.toBe(header);
          if (scenario === "background") {
            expect(document.activeElement).toBe(outside);
          }
        }
      } finally {
        teardown.resolve();
        page.remove();
        window.history.replaceState(null, "", href);
        outside.remove();
      }
    },
  );

  it("ignores ordinary pane focus while Chat is retained behind another page", async () => {
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await page.updateComplete;
    const first = itemAt(page.querySelectorAll<RenderedPane>("openclaw-chat-pane"), 0, "pane");
    first.onOpenSplitView?.();
    await page.updateComplete;
    const activePaneId = getLayout(page)?.activePaneId;
    expect(activePaneId).not.toBe(first.paneId);
    page.presented = false;
    await page.updateComplete;
    navigation.replace.mockClear();

    first.onFocusPane?.(first.paneId);

    expect(getLayout(page)?.activePaneId).toBe(activePaneId);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("applies mounted UI split, focus, and close commands", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const navigation = setNavigationContext(page);
    document.body.append(page);

    const split = new CustomEvent(UI_COMMAND_EVENT, {
      detail: {
        command: { kind: "split", direction: "right", sessionKey: WORK_SESSION_KEY },
        sessionKey: "main",
      },
      cancelable: true,
    });
    window.dispatchEvent(split);
    expect(split.defaultPrevented).toBe(true);
    expect(getLayout(page)?.columns.at(1)?.panes.at(0)?.sessionKey).toBe(WORK_SESSION_KEY);
    expect(navigation.replace).toHaveBeenLastCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });

    window.dispatchEvent(
      new CustomEvent(UI_COMMAND_EVENT, {
        detail: { command: { kind: "focus", sessionKey: "main" }, sessionKey: "main" },
        cancelable: true,
      }),
    );
    expect(getLayout(page)?.activePaneId).toBe("p1");

    window.dispatchEvent(
      new CustomEvent(UI_COMMAND_EVENT, {
        detail: {
          command: { kind: "close-pane", sessionKey: WORK_SESSION_KEY },
          sessionKey: "main",
        },
        cancelable: true,
      }),
    );
    expect(getLayout(page)).toBeUndefined();
  });

  it("leaves UI split commands unhandled on narrow viewports", () => {
    stubMatchMedia(true);
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    setNavigationContext(page);
    document.body.append(page);

    const split = new CustomEvent(UI_COMMAND_EVENT, {
      detail: {
        command: { kind: "split", direction: "right", sessionKey: WORK_SESSION_KEY },
        sessionKey: "main",
      },
      cancelable: true,
    });
    window.dispatchEvent(split);
    // Unhandled so the app host falls back to navigating to the session.
    expect(split.defaultPrevented).toBe(false);
    expect(getLayout(page)).toBeUndefined();
  });

  it("withholds the header split-view opener on narrow single-pane viewports", async () => {
    stubMatchMedia(true);
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await page.updateComplete;

    // Narrow split view renders only the active pane, so offering the opener
    // there would silently hide the second pane it creates.
    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    expect(pane?.onOpenSplitView).toBeUndefined();
  });

  it("replaces a cold literal main route after canonical defaults resolve", async () => {
    window.history.replaceState({}, "", "/chat/research/workspace?draft=ship");
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    const canonicalLocation = createDeferred<RouteLocation | null>();
    page.data = {
      sessionKey: "agent:research:workspace",
      face: "chat",
      draft: "ship",
      canonicalLocationReady: canonicalLocation.promise,
      canonicalLocationSource: {
        pathname: "/chat/research/workspace",
        search: "?draft=ship",
        hash: "",
      },
    };
    document.body.append(page);
    await page.updateComplete;
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledOnce());
    navigation.replace.mockClear();

    canonicalLocation.resolve({
      pathname: "/chat/research",
      search: "?draft=ship&panel=details",
      hash: "",
    });
    await vi.waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("chat", {
        pathname: "/chat/research",
        search: "?panel=details",
        hash: "",
      }),
    );
  });

  it("does not let a cold chat canonicalization replace a newer route", async () => {
    window.history.replaceState({}, "", "/chat/research/workspace");
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    const canonicalLocation = createDeferred<RouteLocation | null>();
    page.data = {
      sessionKey: "agent:research:workspace",
      face: "chat",
      canonicalLocationReady: canonicalLocation.promise,
      canonicalLocationSource: {
        pathname: "/chat/research/workspace",
        search: "",
        hash: "",
      },
    };
    document.body.append(page);
    await page.updateComplete;

    window.history.replaceState({}, "", "/settings/appearance");
    canonicalLocation.resolve({ pathname: "/chat/research", search: "", hash: "" });
    await canonicalLocation.promise;
    await Promise.resolve();

    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("does not let a cold chat canonicalization replace a newer draft", async () => {
    window.history.replaceState({}, "", "/chat/research/workspace?draft=old");
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    const canonicalLocation = createDeferred<RouteLocation | null>();
    page.data = {
      sessionKey: "agent:research:workspace",
      face: "chat",
      draft: "old",
      canonicalLocationReady: canonicalLocation.promise,
      canonicalLocationSource: {
        pathname: "/chat/research/workspace",
        search: "?draft=old",
        hash: "",
      },
    };
    document.body.append(page);
    await page.updateComplete;
    await Promise.resolve();
    navigation.replace.mockClear();

    window.history.replaceState({}, "", "/chat/research/workspace?draft=new");
    canonicalLocation.resolve({ pathname: "/chat/research", search: "?draft=old", hash: "" });
    await canonicalLocation.promise;
    await Promise.resolve();

    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("replaces into the canonical face namespace without adding history", async () => {
    window.history.replaceState({}, "", "/chat");
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    // The loader resolved this session to its stored dashboard face while the route was
    // matched under /chat, so the replacement has to be routed by the resolved face.
    page.data = {
      sessionKey: WORK_SESSION_KEY,
      face: "dashboard",
      canonicalLocation: {
        pathname: "/dashboard/main/deploy-monitor-12345678",
        search: "",
        hash: "",
      },
      canonicalLocationSource: {
        pathname: "/chat",
        search: "",
        hash: "",
      },
    };
    document.body.append(page);
    await page.updateComplete;

    expect(navigation.replace).toHaveBeenCalledWith("dashboard", {
      pathname: "/dashboard/main/deploy-monitor-12345678",
      search: "",
      hash: "",
    });
  });

  it.each([
    { target: "agent:main:main", expectedFace: "dashboard", search: undefined },
    {
      target: "agent:main:uncached",
      expectedFace: "chat",
      search: "?__openclawSessionFacePreference=1",
    },
  ] as const)(
    "preserves face authority when navigating to $target",
    async ({ target, expectedFace, search }) => {
      const page = new ChatPage();
      const navigation = setNavigationContext(page);
      page.data = { sessionKey: "main", face: "dashboard" };
      document.body.append(page);
      await page.updateComplete;

      window.dispatchEvent(
        new CustomEvent(UI_COMMAND_EVENT, {
          cancelable: true,
          detail: { command: { kind: "navigate", sessionKey: target } },
        }),
      );

      expect(navigation.navigate).toHaveBeenCalledWith(expectedFace, {
        pathname: sessionNavigationTarget({
          face: expectedFace,
          sessionKey: target,
          fallbackAgentId: "main",
        }).options.pathname,
        ...(search ? { search } : {}),
      });
    },
  );

  it("keeps catalog identity when consuming a route draft", async () => {
    const expectedSearch = catalogSessionSearch(CATALOG_KEY);
    window.history.replaceState({}, "", `/chat/research${expectedSearch}&draft=ship`);
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    page.data = {
      sessionKey: CATALOG_SESSION_KEY,
      agentId: "research",
      draft: "one-shot catalog draft",
    };
    document.body.append(page);
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledOnce());

    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: "/chat/research",
      search: expectedSearch,
      hash: "",
    });
    await expect(
      loadChatRoute(
        navigation.context,
        { pathname: "/chat/research", search: expectedSearch, hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "session", sessionKey: CATALOG_SESSION_KEY });
  });

  it("keeps catalog identity while switching faces", async () => {
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    page.data = { sessionKey: CATALOG_SESSION_KEY, agentId: "research", face: "chat" };
    document.body.append(page);
    await page.updateComplete;

    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    pane?.onFaceChange?.(pane.paneId, pane.sessionKey, "dashboard");
    const expectedSearch = catalogSessionSearch(CATALOG_KEY);
    expect(navigation.navigate).toHaveBeenCalledWith("dashboard", {
      pathname: "/dashboard/research",
      search: expectedSearch,
    });
    await expect(
      loadChatRoute(
        navigation.context,
        { pathname: "/dashboard/research", search: expectedSearch, hash: "" },
        "dashboard",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "session", sessionKey: CATALOG_SESSION_KEY });
  });

  it("preserves a resolved long prefix through drafts and face changes", async () => {
    window.history.replaceState({}, "", "/chat/main/1234567890?draft=ship");
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    page.data = {
      sessionKey: WORK_SESSION_KEY,
      shortId: "1234567890",
      draft: "ship",
      face: "chat",
    };
    document.body.append(page);
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledOnce());

    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: "/chat/main/1234567890",
      search: "",
      hash: "",
    });
    navigation.navigate.mockClear();
    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    pane?.onFaceChange?.(pane.paneId, pane.sessionKey, "dashboard");
    expect(navigation.navigate).toHaveBeenCalledWith("dashboard", {
      pathname: "/dashboard/main/1234567890",
    });
    expect(navigation.patch).not.toHaveBeenCalled();
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
    const navigation = setNavigationContext(page);
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;

    const panes = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
    const cells = [...page.querySelectorAll<HTMLElement>(".chat-split-view__cell")];
    const dividers = page.querySelectorAll<RenderedDivider>("resizable-divider");
    expect(panes.map((pane) => pane.paneId)).toEqual(["p1", "p2"]);
    expect(panes.map((pane) => pane.active)).toEqual([false, true]);
    expect(cells.map((cell) => cell.getAttribute("aria-current"))).toEqual([null, "true"]);
    expect(dividers).toHaveLength(1);
    expect(itemAt(dividers, 0, "split divider").orientation).toBe("vertical");
    expect(
      page
        .querySelector(".chat-split-view__cell--active")
        ?.contains(itemAt(panes, 1, "rendered pane")),
    ).toBe(true);
    expect(panes.every((pane) => pane.onOpenSplitView === undefined)).toBe(true);
    expect(panes[0]?.chatMessagesBySession).toBe(panes[1]?.chatMessagesBySession);

    itemAt(dividers, 0, "split divider").dispatchEvent(
      new CustomEvent("resize", { detail: { splitRatio: 0.7 } }),
    );
    await page.updateComplete;
    expect(getLayout(page)?.columnWeights[0]).toBeCloseTo(0.7);
    expect(getLayout(page)?.columnWeights[1]).toBeCloseTo(0.3);
    expect(loadSettings().chatSplitLayout).toBeUndefined();

    itemAt(dividers, 0, "split divider").dispatchEvent(new CustomEvent("resize-end"));
    expect(loadSettings().chatSplitLayout?.columnWeights[0]).toBeCloseTo(0.7);
    expect(loadSettings().chatSplitLayout?.columnWeights[1]).toBeCloseTo(0.3);

    itemAt(cells, 0, "split cell").dispatchEvent(new Event("pointerdown"));
    await page.updateComplete;

    expect(
      [...page.querySelectorAll<HTMLElement>(".chat-split-view__cell")].map((cell) =>
        cell.getAttribute("aria-current"),
      ),
    ).toEqual(["true", null]);
    expect(navigation.replace).toHaveBeenCalledOnce();
    itemAt(cells, 0, "split cell").dispatchEvent(new Event("focusin"));
    expect(navigation.replace).toHaveBeenCalledOnce();
  });

  it.each(["pointer", "keyboard", "command", "close"] as const)(
    "keeps the mounted pane's dashboard when activated by %s",
    async (activation) => {
      const page = new ChatPage();
      const navigation = setNavigationContext(page);
      page.data = { sessionKey: "main", face: "chat" };
      document.body.append(page);
      setLayout(page, setPaneSession(createSplitLayout("main"), "p1", WORK_SESSION_KEY));
      await page.updateComplete;
      const [dashboard, chat] = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
      expectDefined(dashboard, "dashboard pane").captureNavigationFace = () => "dashboard";
      navigation.replace.mockClear();
      if (activation === "command") {
        window.dispatchEvent(
          new CustomEvent(UI_COMMAND_EVENT, {
            detail: { command: { kind: "focus", sessionKey: WORK_SESSION_KEY } },
            cancelable: true,
          }),
        );
      } else if (activation === "close") {
        chat?.onClosePane?.(chat.paneId);
      } else {
        dashboard
          ?.closest(".chat-split-view__cell")
          ?.dispatchEvent(new Event(activation === "pointer" ? "pointerdown" : "focusin"));
      }
      expect(navigation.replace).toHaveBeenCalledExactlyOnceWith("dashboard", {
        pathname: sessionNavigationTarget({
          face: "dashboard",
          sessionKey: WORK_SESSION_KEY,
          fallbackAgentId: "main",
        }).options.pathname,
      });
      expect(navigation.patch).not.toHaveBeenCalled();
    },
  );

  it("declares split panes, session switches, pane closes, and page disposal", async () => {
    const page = new ChatPage();
    const { request } = setViewerPresenceContext(page);
    const expectPresence = (sessionKeys: string[]) =>
      expect(request).toHaveBeenLastCalledWith(
        SESSION_VIEWERS_SET_METHOD,
        { sessionKeys },
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, signal: expect.any(AbortSignal) },
      );
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, {
      columns: [
        {
          id: "c1",
          panes: [{ id: "p1", sessionKey: "main" }],
          paneWeights: [1],
        },
        {
          id: "c2",
          panes: [{ id: "p2", sessionKey: "agent:main:other" }],
          paneWeights: [1],
        },
      ],
      columnWeights: [0.5, 0.5],
      activePaneId: "p2",
    });
    await page.updateComplete;
    await Promise.resolve();
    expectPresence(["agent:main:main", "agent:main:other"]);

    const otherPane = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")].find(
      (pane) => pane.paneId === "p2",
    );
    otherPane?.onClosePane?.("p2");
    await page.updateComplete;
    await Promise.resolve();
    expectPresence(["agent:main:main"]);

    page.data = { sessionKey: "agent:main:replacement" };
    await page.updateComplete;
    await Promise.resolve();
    expectPresence(["agent:main:replacement"]);

    page.requestUpdate();
    page.remove();
    await page.updateComplete;
    expectPresence([]);

    document.body.append(page);
    await Promise.resolve();
    expectPresence(["agent:main:replacement"]);
    page.remove();
    await Promise.resolve();
    expectPresence([]);
  });

  it("keeps split panes mounted but presents only the active pane on narrow viewports", async () => {
    stubMatchMedia(true);
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;

    const panes = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
    expect(panes.map((pane) => pane.paneId)).toEqual(["p1", "p2"]);
    expect(panes.filter((pane) => pane.active).map((pane) => pane.paneId)).toEqual(["p2"]);
    expect(panes.every((pane) => pane.narrow)).toBe(true);
    expect(panes.filter((pane) => pane.presented).map((pane) => pane.paneId)).toEqual(["p2"]);
    expect(panes[0]?.hasAttribute("inert")).toBe(true);
    expect(panes[0]?.closest(".chat-split-view__cell--narrow-hidden")).not.toBeNull();
    expect(page.querySelector("resizable-divider")).toBeNull();
  });

  it("retains the active pane element across wide and narrow layouts", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;

    const activePane = itemAt(
      page.querySelectorAll<RenderedPane>("openclaw-chat-pane"),
      1,
      "active wide pane",
    );
    setNarrow(page, true);
    await page.updateComplete;

    const narrowPane = itemAt(
      page.querySelectorAll<RenderedPane>("openclaw-chat-pane"),
      1,
      "active narrow pane",
    );
    expect(narrowPane).toBe(activePane);
    expect(narrowPane.narrow).toBe(true);

    setNarrow(page, false);
    await page.updateComplete;
    expect(
      itemAt(page.querySelectorAll<RenderedPane>("openclaw-chat-pane"), 1, "active restored pane"),
    ).toBe(activePane);
  });

  it("routes a classic-mode center drop without creating a layout", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const navigation = setNavigationContext(page);

    applySessionDrop(page, WORK_SESSION_KEY, "single", { kind: "center" });

    expect(getLayout(page)).toBeUndefined();
    expect(loadSettings().chatSplitLayout).toBeUndefined();
    expect(navigation.navigate).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("creates and persists a classic-mode edge drop on the chosen side", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const navigation = setNavigationContext(page);

    applySessionDrop(page, WORK_SESSION_KEY, "single", { kind: "edge", edge: "left" });

    const layout = getLayout(page);
    expect(layout?.columns.map((column) => column.panes.map((pane) => pane.sessionKey))).toEqual([
      [WORK_SESSION_KEY],
      ["main"],
    ]);
    expect(layout?.activePaneId).toBe("p2");
    expect(loadSettings().chatSplitLayout).toEqual(layout);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });
  });

  it("inserts and persists a dropped session at a layout edge", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    setLayout(page, createSplitLayout("main"));
    const navigation = setNavigationContext(page);

    applySessionDrop(page, WORK_SESSION_KEY, "p1", { kind: "edge", edge: "down" });

    const layout = getLayout(page);
    expect(layout?.columns.at(0)?.panes.map((pane) => pane.sessionKey)).toEqual([
      "main",
      WORK_SESSION_KEY,
    ]);
    expect(layout?.activePaneId).toBe("p3");
    expect(loadSettings().chatSplitLayout).toEqual(layout);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });
  });

  it("replaces and activates the pane under a layout center drop", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    setLayout(page, createSplitLayout("main"));
    const navigation = setNavigationContext(page);

    applySessionDrop(page, WORK_SESSION_KEY, "p1", { kind: "center" });

    const layout = getLayout(page);
    expect(layout?.columns.at(0)?.panes.at(0)?.sessionKey).toBe(WORK_SESSION_KEY);
    expect(layout?.activePaneId).toBe("p1");
    expect(loadSettings().chatSplitLayout).toEqual(layout);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });
  });

  it("leaves a same-session center drop unchanged", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const layout = createSplitLayout("main");
    setLayout(page, layout);
    const navigation = setNavigationContext(page);

    applySessionDrop(page, "main", "p1", { kind: "center" });

    expect(getLayout(page)).toBe(layout);
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("resolves the pane and zone from the drop event", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    const navigation = setNavigationContext(page);
    await page.updateComplete;

    const pane = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")].find(
      (candidate) => candidate.paneId === "p1",
    );
    const container = page.querySelector<HTMLElement>(".chat-split-view__drop-container");
    expect(pane).toBeDefined();
    expect(container).not.toBeNull();
    const paneRect = { left: 100, top: 50, width: 200, height: 100 } as DOMRect;
    const containerRect = { left: 100, top: 50, width: 400, height: 100 } as DOMRect;
    vi.spyOn(pane!, "getBoundingClientRect").mockReturnValue(paneRect);
    vi.spyOn(container!, "getBoundingClientRect").mockReturnValue(containerRect);
    const preventDefault = vi.fn();

    handleDrop(page, {
      target: pane,
      clientX: 105,
      clientY: 100,
      preventDefault,
      dataTransfer: {
        types: [SESSION_DRAG_MIME],
        getData: (type: string) => (type === SESSION_DRAG_MIME ? WORK_SESSION_KEY : ""),
      } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(getLayout(page)?.columns.map((column) => column.panes.at(0)?.sessionKey)).toEqual([
      WORK_SESSION_KEY,
      "main",
      "main",
    ]);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });
  });

  it("accepts an owned header drop and ignores unrelated targets", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    const layout = createSplitLayout("main");
    setLayout(page, layout);
    const navigation = setNavigationContext(page);
    await page.updateComplete;

    const pane = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")].find(
      (candidate) => candidate.paneId === "p1",
    );
    const container = page.querySelector<HTMLElement>(".chat-split-view__drop-container");
    expect(pane).toBeDefined();
    expect(container).not.toBeNull();
    // This host test stubs the stateful chat pane; mirror its exact light-DOM
    // header ownership while the E2E test proves the real component output.
    const header = document.createElement("div");
    header.className = "chat-pane__header";
    pane!.prepend(header);
    expect(header.closest("openclaw-chat-pane")).toBe(pane);
    const paneRect = { left: 100, top: 50, width: 200, height: 100 } as DOMRect;
    const containerRect = { left: 100, top: 50, width: 400, height: 100 } as DOMRect;
    vi.spyOn(pane!, "getBoundingClientRect").mockReturnValue(paneRect);
    vi.spyOn(container!, "getBoundingClientRect").mockReturnValue(containerRect);
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    const dataTransfer = {
      dropEffect: "none",
      getData: (type: string) => (type === SESSION_DRAG_MIME ? WORK_SESSION_KEY : ""),
      types: [SESSION_DRAG_MIME],
    } as unknown as DataTransfer;

    const unrelatedTarget = page.querySelector(".chat-split-view");
    expect(getDropIndicator(page)).toBeNull();
    handleDragOver(page, {
      target: unrelatedTarget,
      clientX: 200,
      clientY: 100,
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent);
    handleDrop(page, {
      target: unrelatedTarget,
      clientX: 200,
      clientY: 100,
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent);
    expect(getDropIndicator(page)).toBeNull();
    expect(getLayout(page)).toBe(layout);
    expect(navigation.replace).not.toHaveBeenCalled();

    handleDragOver(page, {
      target: header,
      clientX: 200,
      clientY: 100,
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent);
    frame?.(0);

    expect(getDropIndicator(page)?.paneId).toBe("p1");
    expect(getDropIndicator(page)?.zone).toEqual({ kind: "center" });

    handleDrop(page, {
      target: header,
      clientX: 200,
      clientY: 100,
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent);

    expect(getLayout(page)?.columns.at(0)?.panes.at(0)?.sessionKey).toBe(WORK_SESSION_KEY);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });
  });
});

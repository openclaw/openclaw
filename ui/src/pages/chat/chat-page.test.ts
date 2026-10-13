/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page.test/"} */

import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import type { RouteLocation } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep this complete mock in the dedicated unit-mock-registry project.
vi.mock("./chat-pane.ts", () => ({}));

import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings, patchSettings } from "../../app/settings.ts";
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
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { setPaneSession } from "./split-layout.ts";

type RenderedPane = HTMLElement & {
  paneId: string;
  focusComposer: boolean;
  chatMessagesBySession: ChatMessageCache;
  sessionKey: string;
  presented: boolean;
  active: boolean;
  presentationTitle: string | undefined;
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

function dispatchSessionDrag(
  target: Element,
  type: string,
  x: number,
  y = 100,
  sessionKey = WORK_SESSION_KEY,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: {
      value: {
        types: [SESSION_DRAG_MIME],
        getData: (mime: string) => (mime === SESSION_DRAG_MIME ? sessionKey : ""),
      },
    },
    clientX: { value: x },
    clientY: { value: y },
  });
  target.dispatchEvent(event);
  return event;
}

function stubDropBounds(page: ChatPage) {
  const pane = expectDefined(
    [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")].find(
      (candidate) => candidate.paneId === "p1",
    ),
    "drop pane",
  );
  const container = expectDefined(
    page.querySelector<HTMLElement>(".chat-split-view__drop-container"),
    "drop container",
  );
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 50,
    width: 200,
    height: 100,
  } as DOMRect);
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 50,
    width: 400,
    height: 100,
  } as DOMRect);
  return pane;
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

  it.each(["focus-moved", "navigation", "suspended", "teardown"] as const)(
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
      button.focus();
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
        } else {
          expect(document.activeElement).not.toBe(header);
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
    expect(page.querySelector(".chat-split-view--active-cell")).toBeNull();
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

  it.each(["command", "close"] as const)(
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
      } else {
        chat?.onClosePane?.(chat.paneId);
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

  it("routes a classic-mode center drop without creating a layout", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const navigation = setNavigationContext(page);

    document.body.append(page);
    await page.updateComplete;
    dispatchSessionDrag(stubDropBounds(page), "drop", 200);

    expect(getLayout(page)).toBeUndefined();
    expect(loadSettings().chatSplitLayout).toBeUndefined();
    expect(navigation.navigate).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("creates and persists a classic-mode edge drop on the chosen side", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const navigation = setNavigationContext(page);

    document.body.append(page);
    await page.updateComplete;
    dispatchSessionDrag(stubDropBounds(page), "drop", 105);

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

  it("inserts and persists a dropped session at a layout edge", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const navigation = setNavigationContext(page);
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;
    dispatchSessionDrag(stubDropBounds(page), "drop", 200, 145);

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

  it("leaves a same-session center drop unchanged", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const layout = createSplitLayout("main");
    const navigation = setNavigationContext(page);
    document.body.append(page);
    setLayout(page, layout);
    await page.updateComplete;
    dispatchSessionDrag(stubDropBounds(page), "drop", 200, 100, "main");

    expect(getLayout(page)).toBe(layout);
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it.each(["unbound"] as const)(
    "does not reuse a sibling's drop indicator over an %s target",
    async (destination) => {
      const page = new ChatPage();
      page.data = { sessionKey: "main" };
      setNavigationContext(page);
      const layout = setPaneSession(createSplitLayout("main"), "p1", "global");
      patchSettings({ chatSplitLayout: layout });
      document.body.append(page);
      await page.updateComplete;
      const bound = expectDefined(
        page.querySelector<RenderedPane>("openclaw-chat-pane.chat-pane-cache__pane--visible"),
        "bound pane",
      );
      const unbound = expectDefined(
        page.querySelector<HTMLElement>("[data-unbound-pane-id]"),
        "unbound pane",
      );
      const container = expectDefined(
        page.querySelector<HTMLElement>(".chat-split-view__drop-container"),
        "drop container",
      );
      vi.spyOn(bound, "getBoundingClientRect").mockReturnValue({
        left: 200,
        top: 0,
        width: 200,
        height: 200,
      } as DOMRect);
      vi.spyOn(unbound, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 200,
        height: 200,
      } as DOMRect);
      vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 400,
        height: 200,
      } as DOMRect);
      let frame: FrameRequestCallback | undefined;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frame = callback;
        return 1;
      });
      dispatchSessionDrag(bound, "dragover", 300);
      frame?.(0);
      const target = destination === "unbound" ? unbound : container;
      dispatchSessionDrag(target, "dragover", 100);
      frame?.(0);
      dispatchSessionDrag(target, "drop", 100);
      expect(getLayout(page)?.columns.map((column) => column.panes[0]?.sessionKey)).toEqual([
        destination === "unbound" ? WORK_SESSION_KEY : "global",
        "main",
      ]);
      await page.updateComplete;
      expect(page.querySelector(".chat-split-view__drop-indicator")).toBeNull();
    },
  );

  it.each(["hidden", "narrow", "disconnected"] as const)(
    "handles header and unrelated drags through %s",
    async (ending) => {
      const viewport = Object.assign(new EventTarget(), { matches: false });
      if (ending === "narrow") {
        const matchMedia = window.matchMedia;
        vi.stubGlobal("matchMedia", (query: string) =>
          query === "(max-width: 1099px)" ? viewport : matchMedia(query),
        );
      }
      const page = new ChatPage();
      page.data = { sessionKey: "main" };
      document.body.append(page);
      const layout = createSplitLayout("main");
      setLayout(page, layout);
      const navigation = setNavigationContext(page);
      await page.updateComplete;

      const pane = stubDropBounds(page);
      // This host test stubs the stateful chat pane; mirror its exact light-DOM
      // header ownership while the E2E test proves the real component output.
      const header = document.createElement("div");
      header.className = "chat-pane__header";
      pane.prepend(header);
      expect(header.closest("openclaw-chat-pane")).toBe(pane);
      let frame: FrameRequestCallback | undefined;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frame = callback;
        return 1;
      });
      const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockClear();
      const unrelatedTarget = expectDefined(page.querySelector(".chat-split-view"), "split view");
      expect(page.querySelector(".chat-split-view__drop-indicator")).toBeNull();
      dispatchSessionDrag(unrelatedTarget, "dragover", 200);
      dispatchSessionDrag(unrelatedTarget, "drop", 200);
      await page.updateComplete;
      expect(page.querySelector(".chat-split-view__drop-indicator")).toBeNull();
      expect(getLayout(page)).toBe(layout);
      expect(navigation.replace).not.toHaveBeenCalled();

      dispatchSessionDrag(header, "dragenter", 200);
      dispatchSessionDrag(header, "dragover", 200);
      frame?.(0);
      await page.updateComplete;
      const indicator = expectDefined(
        page.querySelector<HTMLElement>(".chat-split-view__drop-indicator--center"),
        "center drop indicator",
      );
      expect(indicator.style.left).toBe("0px");
      expect(indicator.style.top).toBe("0px");

      dispatchSessionDrag(header, "dragover", 105);
      if (ending === "hidden") {
        page.presented = false;
      } else if (ending === "narrow") {
        viewport.matches = true;
        viewport.dispatchEvent(Object.assign(new Event("change"), { matches: true }));
      } else {
        page.remove();
      }
      await page.updateComplete;
      // The hiding edge clears in updated(), scheduling one more render.
      await page.updateComplete;
      expect(cancelFrame).toHaveBeenCalledWith(1);
      expect(page.querySelector(".chat-split-view__drop-indicator")).toBeNull();
      frame?.(0);
      await page.updateComplete;
      expect(page.querySelector(".chat-split-view__drop-indicator")).toBeNull();
      expect(dispatchSessionDrag(header, "drop", 105).defaultPrevented).toBe(false);
      expect(getLayout(page)).toBe(layout);
      expect(navigation.navigate).not.toHaveBeenCalled();
      expect(navigation.replace).not.toHaveBeenCalled();
    },
  );
});

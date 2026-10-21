/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page.test/"} */

import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import type { RouteLocation } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

// mock-isolation: Observe page bindings without registering the real pane tag and starting its domain owners.
vi.mock("./chat-pane.tsx", async () => {
  const { mockChatPagePane } = await import("./chat-page-pane.test-support.ts");
  return { ChatPaneView: mockChatPagePane };
});

import { createDeferred } from "../../../../test/helpers/promise.js";
import { mobileNavLayoutMediaQuery } from "../../app/mobile-nav-layout.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { registerMcpAppUnmountTarget } from "../../components/mcp-app-unmount.ts";
import { UI_COMMAND_EVENT, type UiCommandDetail } from "../../components/panel-toggle-contract.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import {
  buildCatalogSessionKey,
  catalogSessionSearch,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createChatPageNavigationContext,
  settleChatPage,
  createSplitLayout,
  setNavigationContext,
  setViewerPresenceContext,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import "./chat-page.tsx";
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
import { setPaneSession } from "./split-layout.ts";

type RenderedPane = HTMLElement & {
  paneId: string;
  paneLabel: string;
  focusComposer: boolean;
  chatMessagesBySession: ChatMessageCache;
  sessionKey: string;
  presented: boolean;
  active: boolean;
  narrow: boolean;
  mergedChrome: boolean;
  onboarding: boolean;
  onOpenSplitView?: () => void;
  onFocusPane?: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
  onFaceChange?: (paneId: string, sessionKey: string, face: "chat" | "dashboard") => void;
  captureNavigationFace?: () => "chat" | "dashboard";
};

type RenderedDivider = HTMLElement & { orientation: "horizontal" | "vertical"; splitRatio: number };

function itemAt<T>(items: ArrayLike<T>, index: number, label: string): T {
  return expectDefined(items[index], `${label} ${index}`);
}

const panesIn = (page: HTMLElementTagNameMap["openclaw-chat-page"]) => [
  ...page.querySelectorAll<RenderedPane>("openclaw-chat-pane"),
];
const paneAt = (page: HTMLElementTagNameMap["openclaw-chat-page"], index = 0) =>
  itemAt(panesIn(page), index, "pane");
const location = (pathname: string, search = "") => ({ pathname, search, hash: "" });

function command(detail: UiCommandDetail) {
  const event = new CustomEvent(UI_COMMAND_EVENT, { detail, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

async function mountPage(
  data: HTMLElementTagNameMap["openclaw-chat-page"]["data"] = { sessionKey: "main" },
  layout?: ReturnType<typeof createSplitLayout>,
) {
  const page = document.createElement("openclaw-chat-page");
  const navigation = setNavigationContext(page);
  page.data = data;
  if (layout) {
    patchSettings({ chatSplitLayout: layout });
  }
  document.body.append(page);
  await settleChatPage(page);
  return { page, navigation };
}

async function coldPage(draft?: string) {
  const source = location("/chat/research/workspace", draft ? `?draft=${draft}` : "");
  window.history.replaceState({}, "", source.pathname + source.search);
  const canonicalLocation = createDeferred<RouteLocation | null>();
  const mounted = await mountPage({
    sessionKey: "agent:research:workspace",
    face: "chat",
    ...(draft ? { draft } : {}),
    canonicalLocationReady: canonicalLocation.promise,
    canonicalLocationSource: source,
  });
  return { ...mounted, canonicalLocation };
}

function mockBounds(element: Element, left: number, top: number, width: number, height: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(left, top, width, height));
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

function stubDropBounds(page: HTMLElementTagNameMap["openclaw-chat-page"]) {
  const pane = expectDefined(
    panesIn(page).find((candidate) => candidate.paneId === "p1"),
    "drop pane",
  );
  const container = expectDefined(
    page.querySelector<HTMLElement>(".chat-split-view__drop-container"),
    ".chat-split-view__drop-container",
  );
  mockBounds(pane, 100, 50, 200, 100);
  mockBounds(container, 100, 50, 400, 100);
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

  it.each([false, true])(
    "derives mobile chrome for the registered page host (onboarding=%s)",
    async (onboarding) => {
      stubMatchMedia(true);
      const container = document.body.appendChild(document.createElement("div"));
      container.className = onboarding ? "shell shell--onboarding" : "shell";
      const { context } = createChatPageNavigationContext();
      const view = mountSolid(
        () =>
          Object.assign(document.createElement("openclaw-chat-page"), {
            context,
            data: { sessionKey: "main" },
          }),
        { container },
      );
      try {
        const page = expectDefined(
          container.querySelector("openclaw-chat-page"),
          "openclaw-chat-page",
        );
        await settleChatPage(page);
        const pane = paneAt(page, 0);

        expect(pane.onboarding).toBe(onboarding);
        expect(pane.mergedChrome).toBe(!onboarding);

        container.className = onboarding ? "shell" : "shell shell--onboarding";
        page.data = { ...page.data };
        await settleChatPage(page);
        expect(paneAt(page)).toBe(pane);
        expect(pane.onboarding).toBe(!onboarding);
        expect(pane.mergedChrome).toBe(onboarding);
      } finally {
        view.unmount();
      }
    },
  );

  it("updates mobile chrome independently of the narrow layout breakpoint", async () => {
    const navigationMedia = Object.assign(new EventTarget(), { matches: false });
    const viewportMedia = Object.assign(new EventTarget(), { matches: false });
    const matchMedia = window.matchMedia;
    vi.stubGlobal("matchMedia", (query: string) =>
      query === mobileNavLayoutMediaQuery()
        ? navigationMedia
        : query === "(max-width: 1099px)"
          ? viewportMedia
          : matchMedia(query),
    );
    const { page } = await mountPage();
    const pane = paneAt(page);
    expect(pane.narrow).toBe(false);
    expect(pane.mergedChrome).toBe(false);

    navigationMedia.matches = true;
    navigationMedia.dispatchEvent(new Event("change"));
    await settleChatPage(page);

    expect(paneAt(page)).toBe(pane);
    expect(pane.narrow).toBe(false);
    expect(pane.mergedChrome).toBe(true);

    navigationMedia.matches = false;
    navigationMedia.dispatchEvent(new Event("change"));
    await settleChatPage(page);
    expect(pane.mergedChrome).toBe(false);

    viewportMedia.matches = true;
    navigationMedia.matches = true;
    viewportMedia.dispatchEvent(new Event("change"));
    await settleChatPage(page);
    expect(pane.narrow).toBe(true);
    expect(pane.mergedChrome).toBe(true);
    expect(paneAt(page)).toBe(pane);
  });

  it("updates a retained pane label on a live locale change", async () => {
    onTestFinished(captureI18nStateForTesting());
    await i18n.setLocale("en");
    const { page } = await mountPage();
    const pane = paneAt(page, 0);
    expect(pane.paneLabel).toBe("Column 1, row 1 (p1)");

    await i18n.setLocale("de");
    flush();

    expect(pane.paneLabel).toBe("Spalte 1, Zeile 1 (p1)");
    expect(page.querySelector("openclaw-chat-pane")).toBe(pane);
  });

  it.each(["focus-moved", "navigation", "suspended", "teardown"] as const)(
    "restores close focus only while its presentation still owns the intent (%s)",
    async (scenario) => {
      const { page } = await mountPage();
      const original = paneAt(page, 0);
      original.onOpenSplitView?.();
      await settleChatPage(page);
      const added = paneAt(page, 1);
      const header = original.appendChild(document.createElement("div"));
      header.className = "chat-pane__header";
      header.tabIndex = -1;
      Object.defineProperty(original, "headerElement", { configurable: true, value: header });
      const button = added.appendChild(document.createElement("button"));
      const outside = document.body.appendChild(document.createElement("button"));
      const teardown = createDeferred();
      if (scenario === "teardown") {
        const app = Object.assign(document.createElement("mcp-app-view"), {
          teardown: () => teardown.promise,
          restartAfterTeardown: () => undefined,
        });
        onTestFinished(registerMcpAppUnmountTarget(app));
        added.append(app);
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
        await settleChatPage(page);
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
    const { page, navigation } = await mountPage();
    const first = paneAt(page, 0);
    first.onOpenSplitView?.();
    await settleChatPage(page);
    const activePaneId = loadSettings().chatSplitLayout?.activePaneId;
    expect(activePaneId).not.toBe(first.paneId);
    page.presented = false;
    await settleChatPage(page);
    expect(page.querySelector(".chat-split-view--active-cell")).toBeNull();
    navigation.replace.mockClear();

    first.onFocusPane?.(first.paneId);

    expect(loadSettings().chatSplitLayout?.activePaneId).toBe(activePaneId);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("applies mounted UI split, focus, and close commands", async () => {
    const { navigation } = await mountPage();

    const split = command({
      command: { kind: "split", direction: "right", sessionKey: WORK_SESSION_KEY },
      sessionKey: "main",
    });
    expect(split.defaultPrevented).toBe(true);
    expect(loadSettings().chatSplitLayout?.columns.at(1)?.panes.at(0)?.sessionKey).toBe(
      WORK_SESSION_KEY,
    );
    expect(navigation.replace).toHaveBeenLastCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });

    command({ command: { kind: "focus", sessionKey: "main" }, sessionKey: "main" });
    expect(loadSettings().chatSplitLayout?.activePaneId).toBe("p1");

    command({
      command: { kind: "close-pane", sessionKey: WORK_SESSION_KEY },
      sessionKey: "main",
    });
    expect(loadSettings().chatSplitLayout).toBeUndefined();
  });

  it("leaves UI split commands unhandled on narrow viewports", async () => {
    stubMatchMedia(true);
    await mountPage();

    const split = command({
      command: { kind: "split", direction: "right", sessionKey: WORK_SESSION_KEY },
      sessionKey: "main",
    });
    // Unhandled so the app host falls back to navigating to the session.
    expect(split.defaultPrevented).toBe(false);
    expect(loadSettings().chatSplitLayout).toBeUndefined();
  });

  it("replaces a cold literal main route after canonical defaults resolve", async () => {
    const { navigation, canonicalLocation } = await coldPage("ship");
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledOnce());
    navigation.replace.mockClear();

    canonicalLocation.resolve({
      pathname: "/chat/research",
      search: "?draft=ship&panel=details",
      hash: "",
    });
    await vi.waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "chat",
        location("/chat/research", "?panel=details"),
      ),
    );
  });

  it("does not let a cold chat canonicalization replace a newer route", async () => {
    const { navigation, canonicalLocation } = await coldPage();

    window.history.replaceState({}, "", "/settings/appearance");
    canonicalLocation.resolve(location("/chat/research"));
    await canonicalLocation.promise;
    await Promise.resolve();

    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("does not let a cold chat canonicalization replace a newer draft", async () => {
    const { navigation, canonicalLocation } = await coldPage("old");
    await Promise.resolve();
    navigation.replace.mockClear();

    window.history.replaceState({}, "", "/chat/research/workspace?draft=new");
    canonicalLocation.resolve(location("/chat/research", "?draft=old"));
    await canonicalLocation.promise;
    await Promise.resolve();

    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("replaces into the canonical face namespace without adding history", async () => {
    window.history.replaceState({}, "", "/chat");
    const page = document.createElement("openclaw-chat-page");
    const navigation = setNavigationContext(page);
    // The loader resolved this session to its stored dashboard face while the route was
    // matched under /chat, so the replacement has to be routed by the resolved face.
    page.data = {
      sessionKey: WORK_SESSION_KEY,
      face: "dashboard",
      canonicalLocation: location("/dashboard/main/deploy-monitor-12345678"),
      canonicalLocationSource: location("/chat"),
    };
    document.body.append(page);
    await settleChatPage(page);

    expect(navigation.replace).toHaveBeenCalledWith(
      "dashboard",
      location("/dashboard/main/deploy-monitor-12345678"),
    );
  });

  it("preserves face authority when navigating to an uncached session", async () => {
    const target = "agent:main:uncached";
    const { navigation } = await mountPage({ sessionKey: "main", face: "dashboard" });
    command({ command: { kind: "navigate", sessionKey: target } });
    expect(navigation.navigate).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(target),
      search: "?__openclawSessionFacePreference=1",
    });
  });

  it("keeps catalog identity when consuming a route draft", async () => {
    const expectedSearch = catalogSessionSearch(CATALOG_KEY);
    window.history.replaceState({}, "", `/chat/research${expectedSearch}&draft=ship`);
    const page = document.createElement("openclaw-chat-page");
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
    const page = document.createElement("openclaw-chat-page");
    const navigation = setNavigationContext(page);
    page.data = {
      sessionKey: WORK_SESSION_KEY,
      shortId: "1234567890",
      draft: "ship",
      face: "chat",
    };
    document.body.append(page);
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledOnce());

    expect(navigation.replace).toHaveBeenCalledWith("chat", location("/chat/main/1234567890"));
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
    const page = document.createElement("openclaw-chat-page");
    setNavigationContext(page);
    document.body.append(page);
    await settleChatPage(page);

    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    expect(pane?.sessionKey).toBe("");
    expect(pane?.active).toBe(true);
  });

  it("renders keyed panes and a divider for a two-column split", async () => {
    const { page, navigation } = await mountPage(undefined, createSplitLayout("main"));

    const panes = panesIn(page);
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
    await settleChatPage(page);
    expect(page.querySelector("resizable-divider")).toBe(dividers[0]);
    expect(itemAt(dividers, 0, "split divider").splitRatio).toBeCloseTo(0.7);
    const columns = page.querySelectorAll<HTMLElement>(".chat-split-view__column");
    expect(Number(itemAt(columns, 0, "split column").style.flexGrow)).toBeCloseTo(0.7);
    expect(Number(itemAt(columns, 1, "split column").style.flexGrow)).toBeCloseTo(0.3);
    expect(loadSettings().chatSplitLayout?.columnWeights).toEqual([0.5, 0.5]);

    itemAt(dividers, 0, "split divider").dispatchEvent(new CustomEvent("resize-end"));
    expect(loadSettings().chatSplitLayout?.columnWeights[0]).toBeCloseTo(0.7);
    expect(loadSettings().chatSplitLayout?.columnWeights[1]).toBeCloseTo(0.3);

    itemAt(cells, 0, "split cell").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settleChatPage(page);

    expect(
      [...page.querySelectorAll<HTMLElement>(".chat-split-view__cell")].map((cell) =>
        cell.getAttribute("aria-current"),
      ),
    ).toEqual(["true", null]);
    expect(navigation.replace).toHaveBeenCalledOnce();
    itemAt(cells, 0, "split cell").dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(navigation.replace).toHaveBeenCalledOnce();

    itemAt(panes, 1, "closing pane").onClosePane?.("p2");
    await settleChatPage(page);
    command({ command: { kind: "split", direction: "down", sessionKey: "main" } });
    await settleChatPage(page);
    const horizontal = expectDefined(
      page.querySelector<RenderedDivider>("resizable-divider"),
      "resizable-divider",
    );
    expect(horizontal.orientation).toBe("horizontal");
    horizontal.focus();
    expect(document.activeElement).toBe(horizontal);
    horizontal.dispatchEvent(new CustomEvent("resize", { detail: { splitRatio: 0.65 } }));
    await settleChatPage(page);
    expect(page.querySelector("resizable-divider")).toBe(horizontal);
    expect(document.activeElement).toBe(horizontal);
    expect(horizontal.splitRatio).toBeCloseTo(0.65);
    const rows = page.querySelectorAll<HTMLElement>(".chat-split-view__cell");
    expect(Number(itemAt(rows, 0, "split row").style.flexGrow)).toBeCloseTo(0.65);
    expect(Number(itemAt(rows, 1, "split row").style.flexGrow)).toBeCloseTo(0.35);
    expect(loadSettings().chatSplitLayout?.columns[0]?.paneWeights).toEqual([0.5, 0.5]);
  });

  it.each(["command", "close"] as const)(
    "keeps the mounted pane's dashboard when activated by %s",
    async (activation) => {
      const { page, navigation } = await mountPage(
        { sessionKey: "main", face: "chat" },
        setPaneSession(createSplitLayout("main"), "p1", WORK_SESSION_KEY),
      );
      const [dashboard, chat] = panesIn(page);
      expectDefined(dashboard, "dashboard pane").captureNavigationFace = () => "dashboard";
      navigation.replace.mockClear();
      if (activation === "command") {
        command({ command: { kind: "focus", sessionKey: WORK_SESSION_KEY } });
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
    const page = document.createElement("openclaw-chat-page");
    const { request } = setViewerPresenceContext(page);
    const expectPresence = (sessionKeys: string[]) =>
      expect(request).toHaveBeenLastCalledWith(
        SESSION_VIEWERS_SET_METHOD,
        { sessionKeys },
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, signal: expect.any(AbortSignal) },
      );
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await settleChatPage(page);
    command({ command: { kind: "split", direction: "right", sessionKey: "agent:main:other" } });
    await settleChatPage(page);
    await Promise.resolve();
    expectPresence(["agent:main:main", "agent:main:other"]);

    const otherPane = panesIn(page).find((pane) => pane.paneId === "p2");
    otherPane?.onClosePane?.("p2");
    await settleChatPage(page);
    await Promise.resolve();
    expectPresence(["agent:main:main"]);

    page.data = { sessionKey: "agent:main:replacement" };
    await settleChatPage(page);
    await Promise.resolve();
    expectPresence(["agent:main:replacement"]);

    page.navDrawerOpen = true;
    page.remove();
    await settleChatPage(page);
    expectPresence([]);

    document.body.append(page);
    await settleChatPage(page);
    expectPresence(["agent:main:replacement"]);
    page.remove();
    await settleChatPage(page);
    expectPresence([]);
  });

  it("routes a classic-mode center drop without creating a layout", async () => {
    const { page, navigation } = await mountPage();
    dispatchSessionDrag(stubDropBounds(page), "drop", 200);

    expect(loadSettings().chatSplitLayout).toBeUndefined();
    expect(navigation.navigate).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("creates and persists a classic-mode edge drop on the chosen side", async () => {
    const { page, navigation } = await mountPage();
    dispatchSessionDrag(stubDropBounds(page), "drop", 105);

    const layout = loadSettings().chatSplitLayout;
    expect(layout?.columns.map((column) => column.panes.map((pane) => pane.sessionKey))).toEqual([
      [WORK_SESSION_KEY],
      ["main"],
    ]);
    expect(layout?.activePaneId).toBe("p2");
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });
  });

  it("inserts and persists a dropped session at a layout edge", async () => {
    const { page, navigation } = await mountPage(undefined, createSplitLayout("main"));
    dispatchSessionDrag(stubDropBounds(page), "drop", 200, 145);

    const layout = loadSettings().chatSplitLayout;
    expect(layout?.columns.at(0)?.panes.map((pane) => pane.sessionKey)).toEqual([
      "main",
      WORK_SESSION_KEY,
    ]);
    expect(layout?.activePaneId).toBe("p3");
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
      search: "?__openclawSessionFacePreference=1",
    });
  });

  it("leaves a same-session center drop unchanged", async () => {
    const layout = createSplitLayout("main");
    const { page, navigation } = await mountPage(undefined, layout);
    dispatchSessionDrag(stubDropBounds(page), "drop", 200, 100, "main");

    expect(loadSettings().chatSplitLayout).toEqual(layout);
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("does not reuse a sibling's drop indicator over an unbound target", async () => {
    const page = document.createElement("openclaw-chat-page");
    page.data = { sessionKey: "main" };
    setNavigationContext(page);
    const layout = setPaneSession(createSplitLayout("main"), "p1", "global");
    patchSettings({ chatSplitLayout: layout });
    document.body.append(page);
    await settleChatPage(page);
    const bound = expectDefined(
      page.querySelector<RenderedPane>("openclaw-chat-pane.chat-pane-cache__pane--visible"),
      "openclaw-chat-pane.chat-pane-cache__pane--visible",
    );
    const unbound = expectDefined(
      page.querySelector<HTMLElement>("[data-unbound-pane-id]"),
      "[data-unbound-pane-id]",
    );
    const container = expectDefined(
      page.querySelector<HTMLElement>(".chat-split-view__drop-container"),
      ".chat-split-view__drop-container",
    );
    mockBounds(bound, 200, 0, 200, 200);
    mockBounds(unbound, 0, 0, 200, 200);
    mockBounds(container, 0, 0, 400, 200);
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    dispatchSessionDrag(bound, "dragover", 300);
    frame?.(0);
    const target = unbound;
    dispatchSessionDrag(target, "dragover", 100);
    frame?.(0);
    dispatchSessionDrag(target, "drop", 100);
    expect(
      loadSettings().chatSplitLayout?.columns.map((column) => column.panes[0]?.sessionKey),
    ).toEqual([WORK_SESSION_KEY, "main"]);
    await settleChatPage(page);
    expect(page.querySelector(".chat-split-view__drop-indicator")).toBeNull();
  });

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
      const layout = createSplitLayout("main");
      const { page, navigation } = await mountPage(undefined, layout);

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
      await settleChatPage(page);
      expect(page.querySelector(".chat-split-view__drop-indicator")).toBeNull();
      expect(loadSettings().chatSplitLayout).toEqual(layout);
      expect(navigation.replace).not.toHaveBeenCalled();

      dispatchSessionDrag(header, "dragenter", 200);
      dispatchSessionDrag(header, "dragover", 200);
      frame?.(0);
      await settleChatPage(page);
      const indicator = expectDefined(
        page.querySelector<HTMLElement>(".chat-split-view__drop-indicator--center"),
        ".chat-split-view__drop-indicator--center",
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
      await settleChatPage(page);
      // The hiding edge clears in updated(), scheduling one more render.
      await settleChatPage(page);
      expect(cancelFrame).toHaveBeenCalledWith(1);
      expect(page.querySelector(".chat-split-view__drop-indicator")).toBeNull();
      frame?.(0);
      await settleChatPage(page);
      expect(page.querySelector(".chat-split-view__drop-indicator")).toBeNull();
      expect(dispatchSessionDrag(header, "drop", 105).defaultPrevented).toBe(false);
      expect(loadSettings().chatSplitLayout).toEqual(layout);
      expect(navigation.navigate).not.toHaveBeenCalled();
      expect(navigation.replace).not.toHaveBeenCalled();
    },
  );
});

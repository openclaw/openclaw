/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-retained.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

vi.mock("./chat-pane.ts", () => ({}));
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import type { GatewayHelloOk } from "../../api/gateway.ts";
import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import {
  runSessionNavigationIntent,
  SESSION_NAVIGATION_INTENT_EVENT,
} from "../../lib/sessions/navigation-handoff.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { QUEUED_EDIT_RETENTION_CHANGE_EVENT } from "./chat-page-retained-sessions.ts";
import { setNavigationContext } from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";
import { routeDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";

type RenderedPane = HTMLElement & {
  active: boolean;
  onOpenSplitView?: () => void;
  hasQueuedMessageEdit?: boolean;
  draft?: string;
  focusComposer: boolean;
  onFaceChange?: (paneId: string, sessionKey: string, face: "chat" | "dashboard") => void;
  onPaneSessionChange?: (
    paneId: string,
    nextSessionKey: string,
    options?: { replace?: boolean },
  ) => boolean | void;
  onSessionDeleted?: (paneId: string, sessionKey: string, replacementSessionKey: string) => void;
  paneId: string;
  presentationId: string;
  presented: boolean;
  routeFace: "chat" | "dashboard";
  dashboardExpanded: boolean;
  sessionKey: string;
};

function getRouteDraftForActivePane(page: ChatPage): string | undefined {
  const state = page as unknown as {
    data: SessionChatRouteData;
    consumedDraftData: SessionChatRouteData | null;
  };
  return routeDraft(state.data, state.consumedDraftData);
}

function stubMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

async function showSession(page: ChatPage, sessionKey: string): Promise<void> {
  page.data = { sessionKey };
  await page.updateComplete;
  await page.updateComplete;
}

async function mountRetainedPage(sessionKey: string, ...warmSessionKeys: string[]) {
  const page = new ChatPage();
  const navigation = setNavigationContext(page);
  page.data = { sessionKey };
  document.body.append(page);
  await page.updateComplete;
  for (const key of warmSessionKeys) {
    await showSession(page, key);
  }
  const panes = () => [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
  const paneFor = (key: string) => panes().find((pane) => pane.sessionKey === key);
  return { navigation, page, paneFor, panes };
}

describe("chat page retained sessions", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.clear();
    stubMatchMedia();
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("keeps route ownership on the selected split pane while dock input is active", async () => {
    const page = new ChatPage();
    const workSessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const { context } = setNavigationContext(page);
    page.data = { sessionKey: workSessionKey, agentId: "main" };
    document.body.append(page);
    await page.updateComplete;
    chatInputOwnerForContext(context).claim("dock");
    const otherSession = "agent:research:review";
    window.dispatchEvent(
      new CustomEvent(UI_COMMAND_EVENT, {
        detail: {
          command: { kind: "split", direction: "right", sessionKey: otherSession },
          sessionKey: workSessionKey,
        },
        cancelable: true,
      }),
    );
    await page.updateComplete;
    expect(context.gateway.setSessionKey).toHaveBeenLastCalledWith(otherSession);
    expect(context.agentSelection.set).toHaveBeenLastCalledWith("research", { background: true });
    page
      .querySelector<HTMLElement>(".chat-split-view__cell")
      ?.dispatchEvent(new Event("pointerdown"));
    await page.updateComplete;

    expect(context.gateway.setSessionKey).toHaveBeenLastCalledWith(workSessionKey);
    expect(loadSettings()).toMatchObject({
      sessionKey: workSessionKey,
      lastActiveSessionKey: workSessionKey,
    });
    expect(context.agentSelection.set).toHaveBeenLastCalledWith("main", { background: true });
    expect(chatInputOwnerForContext(context).current).toBe("dock");
  });

  it("binds newly resolved Home defaults even when the canonical route is equivalent", async () => {
    const page = new ChatPage();
    const { context, navigate, replace } = setNavigationContext(page);
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await page.updateComplete;
    context.gateway.snapshot.hello = {
      snapshot: { sessionDefaults: { mainKey: "main", mainSessionKey: "agent:main:main" } },
    } as GatewayHelloOk;
    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane")!;

    pane.onPaneSessionChange?.(pane.paneId, "agent:main:main");

    expect(context.gateway.setSessionKey).toHaveBeenLastCalledWith("agent:main:main");
    expect(loadSettings().sessionKey).toBe("agent:main:main");
    expect(navigate).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("hands each route-provided draft to the active pane only once", async () => {
    window.history.replaceState({}, "", "/chat/main?draft=one-shot%20draft&panel=details#pane");
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    const firstRouteData = { sessionKey: "main", draft: "one-shot draft" };
    page.data = firstRouteData;
    expect(getRouteDraftForActivePane(page)).toBe("one-shot draft");

    document.body.append(page);
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledOnce());

    expect(getRouteDraftForActivePane(page)).toBeUndefined();
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionNavigationTarget({
        face: "chat",
        sessionKey: "main",
        fallbackAgentId: "main",
      }).options.pathname,
      search: "?panel=details",
      hash: "#pane",
    });
    page.data = { ...firstRouteData };
    expect(getRouteDraftForActivePane(page)).toBe("one-shot draft");
  });

  it("retains three session panes and reactivates them without remounting", async () => {
    const { page, paneFor, panes } = await mountRetainedPage("agent:main:a");
    const paneA = paneFor("agent:main:a");
    expect(paneA).toBeDefined();

    await showSession(page, "agent:main:b");
    const paneB = paneFor("agent:main:b");
    expect(paneB).toBeDefined();
    expect(paneB?.presentationId).not.toBe(paneA?.presentationId);
    expect(paneA?.active).toBe(false);
    expect(paneA?.presented).toBe(false);
    expect(paneA?.hasAttribute("inert")).toBe(true);
    expect(paneA?.getAttribute("aria-hidden")).toBe("true");
    expect(paneB?.active).toBe(true);
    expect(paneB?.presented).toBe(true);
    expect(paneB?.hasAttribute("inert")).toBe(false);

    await showSession(page, "agent:main:a");
    expect(paneFor("agent:main:a")).toBe(paneA);
    expect(paneFor("agent:main:b")).toBe(paneB);

    await showSession(page, "agent:main:c");
    await showSession(page, "agent:main:d");
    expect(
      panes()
        .map((pane) => pane.sessionKey)
        .toSorted(),
    ).toEqual(["agent:main:a", "agent:main:c", "agent:main:d"]);
    expect(paneB?.isConnected).toBe(false);
  });

  it("keeps edited panes mounted through overflow and prunes released custody without moving survivors", async () => {
    const { page, paneFor, panes } = await mountRetainedPage("agent:main:a");
    const paneA = expectDefined(paneFor("agent:main:a"), "first edited pane");
    paneA.hasQueuedMessageEdit = true;
    await showSession(page, "agent:main:b");
    const paneB = expectDefined(paneFor("agent:main:b"), "second edited pane");
    paneB.hasQueuedMessageEdit = true;
    await showSession(page, "agent:main:c");
    const paneC = expectDefined(paneFor("agent:main:c"), "third edited pane");
    paneC.hasQueuedMessageEdit = true;
    await showSession(page, "agent:main:d");
    expect(panes()).toHaveLength(4);
    await showSession(page, "agent:main:e");
    const paneE = paneFor("agent:main:e");
    expect(paneFor("agent:main:d")).toBeUndefined();
    expect(panes()).toHaveLength(4);
    expect(paneFor("agent:main:a")).toBe(paneA);
    expect(paneFor("agent:main:b")).toBe(paneB);
    expect(paneFor("agent:main:c")).toBe(paneC);

    paneB.hasQueuedMessageEdit = false;
    paneB.dispatchEvent(new Event(QUEUED_EDIT_RETENTION_CHANGE_EVENT, { bubbles: true }));
    await page.updateComplete;
    expect(panes()).toHaveLength(3);
    expect(paneB.isConnected).toBe(false);
    expect(paneFor("agent:main:a")).toBe(paneA);
    expect(paneFor("agent:main:c")).toBe(paneC);
    expect(paneFor("agent:main:e")).toBe(paneE);

    paneA.hasQueuedMessageEdit = false;
    paneC.hasQueuedMessageEdit = false;
    await showSession(page, "agent:main:f");
    await showSession(page, "agent:main:g");
    expect(panes()).toHaveLength(3);
    expect(paneFor("agent:main:a")).toBeUndefined();
    expect(paneFor("agent:main:c")).toBeUndefined();
    expect(paneFor("agent:main:e")).toBe(paneE);
  });

  it("parks pane activity and ignores session commands while another page is presented", async () => {
    const { page, paneFor, navigation } = await mountRetainedPage("agent:main:a", "agent:main:b");
    const paneB = paneFor("agent:main:b");
    page.presented = false;
    await page.updateComplete;
    navigation.navigate.mockClear();
    navigation.context.gateway.setSessionKey = vi.fn();
    expect(paneB?.isConnected).toBe(true);
    expect(paneB?.active).toBe(false);
    expect(paneB?.presented).toBe(false);
    expect(paneB?.hasAttribute("inert")).toBe(true);

    const intent = new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
      cancelable: true,
      detail: { commit: () => true, face: "chat", sessionKey: "agent:main:a" },
    });
    window.dispatchEvent(intent);
    expect(intent.defaultPrevented).toBe(false);
    const command = new CustomEvent(UI_COMMAND_EVENT, {
      cancelable: true,
      detail: { command: { kind: "navigate", sessionKey: "agent:main:a" } },
    });
    window.dispatchEvent(command);
    expect(command.defaultPrevented).toBe(false);
    expect(paneB?.onPaneSessionChange?.(paneB.paneId, "agent:main:a")).toBe(false);
    paneB?.onFaceChange?.(paneB.paneId, "agent:main:b", "dashboard");
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.patch).not.toHaveBeenCalled();
    expect(navigation.context.gateway.setSessionKey).not.toHaveBeenCalled();

    page.presented = true;
    await page.updateComplete;
    expect(paneFor("agent:main:b")).toBe(paneB);
    expect(paneB?.active).toBe(true);
    expect(paneB?.presented).toBe(true);
    expect(paneB?.hasAttribute("inert")).toBe(false);
  });

  it.each([
    { retainedSessionKey: "main", routeSessionKey: "agent:main:main" },
    { retainedSessionKey: "agent:main:main", routeSessionKey: "main" },
  ])(
    "delivers a one-shot route draft and composer focus across the $retainedSessionKey alias",
    async ({ retainedSessionKey, routeSessionKey }) => {
      const { navigation, page, paneFor } = await mountRetainedPage(retainedSessionKey);
      const pane = expectDefined(paneFor(retainedSessionKey), "retained main chat pane");
      const receivedDrafts: Array<string | undefined> = [];
      const focusRequests: boolean[] = [];
      const paneCommit = createDeferred();

      Object.defineProperties(pane, {
        updateComplete: { configurable: true, value: paneCommit.promise },
        draft: {
          configurable: true,
          get: () => receivedDrafts.at(-1),
          set: (value: string | undefined) => receivedDrafts.push(value),
        },
        focusComposer: {
          configurable: true,
          get: () => focusRequests.at(-1) ?? false,
          set: (value: boolean) => focusRequests.push(value),
        },
      });

      page.data = {
        sessionKey: routeSessionKey,
        draft: "What can you do?",
        focusComposer: true,
      };
      await page.updateComplete;
      await Promise.resolve();
      expect(pane.draft).toBe("What can you do?");
      expect(pane.focusComposer).toBe(true);
      expect(navigation.replace).not.toHaveBeenCalled();
      paneCommit.resolve();
      await Promise.resolve();
      await page.updateComplete;

      expect(paneFor(retainedSessionKey)).toBe(pane);
      expect(receivedDrafts.filter((draft) => draft !== undefined)).toEqual(["What can you do?"]);
      expect(focusRequests).toContain(true);
      expect(navigation.replace).toHaveBeenCalledOnce();

      page.data = { sessionKey: routeSessionKey };
      await page.updateComplete;
    },
  );

  it.each([
    { routeSessionKey: "agent:main:main", paneSessionKey: "" },
    { routeSessionKey: "agent:main:main", paneSessionKey: "global" },
    { routeSessionKey: "agent:main:main", paneSessionKey: "agent:research:main" },
    {
      routeSessionKey: "agent:ops:matrix:channel:!Room:Example.Org",
      paneSessionKey: "agent:ops:matrix:channel:!room:example.org",
    },
    {
      routeSessionKey: "agent:ops:signal:group:AbC123=",
      paneSessionKey: "agent:ops:signal:group:abc123=",
    },
  ])("never sends a route draft to a different session", ({ routeSessionKey, paneSessionKey }) => {
    expect(
      routeDraft({ sessionKey: routeSessionKey, draft: "private draft" }, null, paneSessionKey),
    ).toBeUndefined();
  });

  it("never replays a consumed route draft through an equivalent main alias", () => {
    const data = { sessionKey: "agent:main:main", draft: "already delivered" };
    expect(routeDraft(data, data, "main")).toBeUndefined();
  });

  it("hands route-owned focus to the final page across pane replacement", async () => {
    const sourcePage = new ChatPage();
    setNavigationContext(sourcePage);
    sourcePage.data = {
      sessionKey: "main",
      draft: "What can you do?",
      focusComposer: true,
    };
    const page = new ChatPage();
    setNavigationContext(page);
    page.data = { sessionKey: "main" };

    vi.useFakeTimers();
    try {
      document.body.append(sourcePage);
      await sourcePage.updateComplete;
      await Promise.resolve();

      document.body.append(page);
      await page.updateComplete;
      const pane = expectDefined(
        page.querySelector<RenderedPane>("openclaw-chat-pane"),
        "retained chat pane",
      );
      expect(pane.focusComposer).toBe(true);

      const combobox = document.createElement("div");
      combobox.className = "agent-chat__composer-combobox";
      const textarea = document.createElement("textarea");
      combobox.append(textarea);
      pane.append(combobox);
      vi.advanceTimersByTime(250);
      expect(document.activeElement).toBe(textarea);

      const replacementPane = document.createElement("openclaw-chat-pane") as RenderedPane;
      replacementPane.active = true;
      replacementPane.sessionKey = "main";
      const replacementCombobox = document.createElement("div");
      replacementCombobox.className = "agent-chat__composer-combobox";
      const replacementTextarea = document.createElement("textarea");
      replacementCombobox.append(replacementTextarea);
      replacementPane.append(replacementCombobox);
      pane.replaceWith(replacementPane);

      vi.advanceTimersByTime(250);
      expect(document.activeElement).toBe(replacementTextarea);

      const userTarget = document.createElement("button");
      document.body.append(userTarget);
      userTarget.focus();
      vi.advanceTimersByTime(250);
      expect(document.activeElement).toBe(userTarget);
    } finally {
      sourcePage.remove();
      page.remove();
      vi.useRealTimers();
    }
  });

  it("rejects navigation and face changes from a hidden retained session", async () => {
    const { navigation, page, paneFor } = await mountRetainedPage("agent:main:a", "agent:main:b");
    const paneA = paneFor("agent:main:a");
    navigation.navigate.mockClear();
    navigation.patch.mockClear();

    expect(paneA?.onPaneSessionChange?.("p1", "agent:main:stale-result")).toBe(false);
    paneA?.onFaceChange?.("p1", "agent:main:a", "dashboard");

    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.patch).not.toHaveBeenCalled();
    expect(page.data.sessionKey).toBe("agent:main:b");

    page.remove();
    expect(navigation.chatAttachmentHandoff.clearPane).not.toHaveBeenCalled();
  });

  it("rejects a pane callback while a newer browser route is loading", async () => {
    const { navigation, page } = await mountRetainedPage("main");
    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    const previousHref = window.location.href;

    try {
      history.pushState(null, "", "/chat/main?catalog=pi&host=node&thread=next");

      expect(pane?.onPaneSessionChange?.("p1", "agent:main:main", { replace: true })).toBe(false);
      expect(navigation.replace).not.toHaveBeenCalled();
    } finally {
      history.replaceState(null, "", previousHref);
    }
  });

  it.each([
    { sourceFace: "chat", targetFace: "chat" },
    { sourceFace: "chat", targetFace: "dashboard" },
    { sourceFace: "dashboard", targetFace: "chat" },
  ] as const)(
    "presents a retained $targetFace from $sourceFace before route data resolves",
    async ({ sourceFace, targetFace }) => {
      const { page, paneFor, panes } = await mountRetainedPage(
        "agent:main:a",
        "agent:main:b",
        "agent:main:a",
      );
      const paneA = paneFor("agent:main:a");
      const paneB = paneFor("agent:main:b");
      page.data = { sessionKey: "agent:main:b", face: targetFace, dashboardExpanded: true };
      await page.updateComplete;
      page.data = { sessionKey: "agent:main:a", face: sourceFace };
      await page.updateComplete;
      expect(paneB?.routeFace).toBe(targetFace);
      expect(paneB?.dashboardExpanded).toBe(true);

      const intent = new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: targetFace, sessionKey: "agent:main:b" },
      });
      window.dispatchEvent(intent);

      expect(intent.defaultPrevented).toBe(true);
      expect(page.data.sessionKey).toBe("agent:main:a");
      expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
      expect(paneA?.presented).toBe(true);
      expect(paneA?.hasAttribute("inert")).toBe(true);
      expect(paneA?.getAttribute("aria-hidden")).toBe("false");
      expect(paneB?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
      expect(paneB?.presented).toBe(false);
      expect(paneB?.hasAttribute("inert")).toBe(true);
      expect(paneB?.getAttribute("aria-hidden")).toBe("true");
      expect(paneA?.active).toBe(true);
      expect(paneB?.active).toBe(false);

      window.dispatchEvent(
        new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
          cancelable: true,
          detail: { commit: () => true, face: sourceFace, sessionKey: "agent:main:a" },
        }),
      );
      expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
      expect(paneA?.presented).toBe(true);
      expect(paneA?.hasAttribute("inert")).toBe(false);
      expect(paneB?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
      expect(paneB?.presented).toBe(false);
      expect(paneB?.hasAttribute("inert")).toBe(true);

      window.dispatchEvent(
        new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
          cancelable: true,
          detail: { commit: () => true, face: targetFace, sessionKey: "agent:main:b" },
        }),
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(paneA?.presented).toBe(true);
      expect(paneB?.presented).toBe(false);

      window.dispatchEvent(
        new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
          cancelable: true,
          detail: { commit: () => true, face: targetFace, sessionKey: "agent:main:b" },
        }),
      );
      page.data = { sessionKey: "agent:main:b", face: targetFace };
      await page.updateComplete;
      await page.updateComplete;
      expect(panes().find((pane) => pane.sessionKey === "agent:main:b")).toBe(paneB);
      expect(paneA?.active).toBe(false);
      expect(paneA?.presented).toBe(false);
      expect(paneA?.hasAttribute("inert")).toBe(true);
      expect(paneB?.active).toBe(true);
      expect(paneB?.presented).toBe(true);
      expect(paneB?.hasAttribute("inert")).toBe(false);
    },
  );

  it("evicts a deleted inactive retained session without redirecting the active pane", async () => {
    const { navigation, page, paneFor, panes } = await mountRetainedPage(
      "agent:main:a",
      "agent:main:b",
    );
    const paneA = paneFor("agent:main:a");
    navigation.navigate.mockClear();

    paneA?.onSessionDeleted?.("p1", "agent:main:a", "agent:main:main");
    await page.updateComplete;

    expect(panes().some((pane) => pane.sessionKey === "agent:main:a")).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(page.data.sessionKey).toBe("agent:main:b");
  });

  it("reuses a deleted middle position without replacing survivors or changing eviction recency", async () => {
    const { page, paneFor, panes } = await mountRetainedPage(
      "agent:main:a",
      "agent:main:b",
      "agent:main:c",
    );
    const paneA = paneFor("agent:main:a");
    const paneB = paneFor("agent:main:b");
    const paneC = paneFor("agent:main:c");

    paneB?.onSessionDeleted?.("p1", "agent:main:b", "agent:main:main");
    await page.updateComplete;
    await showSession(page, "agent:main:d");

    expect(paneB?.isConnected).toBe(false);
    expect(paneFor("agent:main:a")).toBe(paneA);
    expect(paneFor("agent:main:c")).toBe(paneC);
    expect(
      panes()
        .map((pane) => pane.sessionKey)
        .toSorted(),
    ).toEqual(["agent:main:a", "agent:main:c", "agent:main:d"]);

    await showSession(page, "agent:main:a");
    await showSession(page, "agent:main:e");

    expect(paneFor("agent:main:a")).toBe(paneA);
    expect(paneC?.isConnected).toBe(false);
    expect(
      panes()
        .map((pane) => pane.sessionKey)
        .toSorted(),
    ).toEqual(["agent:main:a", "agent:main:d", "agent:main:e"]);
  });

  it("rolls a retained preview back when authoritative navigation never commits", async () => {
    vi.useFakeTimers();
    try {
      const { paneFor } = await mountRetainedPage("agent:main:a", "agent:main:b", "agent:main:a");
      const paneA = paneFor("agent:main:a");
      const paneB = paneFor("agent:main:b");

      window.dispatchEvent(
        new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
          cancelable: true,
          detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
        }),
      );
      expect(paneA?.presented).toBe(true);
      expect(paneA?.hasAttribute("inert")).toBe(true);
      expect(paneB?.presented).toBe(false);
      expect(paneB?.hasAttribute("inert")).toBe(true);
      vi.advanceTimersByTime(5_000);

      expect(paneA?.presented).toBe(true);
      expect(paneA?.hasAttribute("inert")).toBe(false);
      expect(paneB?.presented).toBe(false);
      expect(paneB?.hasAttribute("inert")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits a retained session intent while another route is still loading", async () => {
    const originalHref = window.location.href;
    const { page, paneFor } = await mountRetainedPage(
      "agent:main:a",
      "agent:main:b",
      "agent:main:a",
    );
    const paneB = expectDefined(paneFor("agent:main:b"), "retained navigation target");
    const commit = vi.fn(() => true);
    try {
      // The router advances history before a cold route replaces the visible Chat page.
      window.history.pushState(null, "", "/agents");
      expect(page.presented).toBe(true);
      runSessionNavigationIntent(paneB, {
        commit,
        face: "chat",
        sessionKey: "agent:main:b",
      });

      expect(commit).toHaveBeenCalledOnce();
      expect(paneB.hasAttribute("inert")).toBe(true);
      expect(paneFor("agent:main:a")?.hasAttribute("inert")).toBe(false);
      page.presented = false;
      await page.updateComplete;
      expect(commit).toHaveBeenCalledOnce();
    } finally {
      window.history.replaceState(null, "", originalHref);
    }
  });

  it("retires a retained preview when newer navigation supersedes its pending route", async () => {
    const originalHref = window.location.href;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => frames.delete(frame));
    const { page, paneFor } = await mountRetainedPage(
      "agent:main:a",
      "agent:main:b",
      "agent:main:a",
    );
    const paneA = expectDefined(paneFor("agent:main:a"), "selected conversation");
    const paneB = expectDefined(paneFor("agent:main:b"), "retained conversation");
    const returnToA = vi.fn(() => true);
    try {
      runSessionNavigationIntent(paneA, {
        face: "chat",
        sessionKey: paneB.sessionKey,
        commit: () => {
          // Route history advances immediately; data is still awaiting its loader.
          history.pushState(null, "", "/chat/pending-b");
          return true;
        },
      });
      frames.get(1)?.(0);
      frames.get(2)?.(16);
      expect(paneB.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
      expect(page.data.sessionKey).toBe(paneA.sessionKey);

      runSessionNavigationIntent(paneA, {
        commit: returnToA,
        face: "chat",
        sessionKey: paneA.sessionKey,
      });

      expect(returnToA).toHaveBeenCalledOnce();
      expect(paneA.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
      expect(paneA.hasAttribute("inert")).toBe(false);
      expect(paneB.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
      expect(paneB.hasAttribute("inert")).toBe(true);
    } finally {
      page.remove();
      history.replaceState(null, "", originalHref);
      vi.restoreAllMocks();
    }
  });

  it("cannot commit a retained navigation after supersession or page disposal", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      frames.delete(frame);
    });
    const { page } = await mountRetainedPage(
      "agent:main:a",
      "agent:main:b",
      "agent:main:c",
      "agent:main:a",
    );
    const commitB = vi.fn(() => true);
    const commitC = vi.fn(() => true);

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: commitB, face: "chat", sessionKey: "agent:main:b" },
      }),
    );
    frames.get(1)?.(0);
    const staleSecondFrame = frames.get(2);
    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: commitC, face: "chat", sessionKey: "agent:main:c" },
      }),
    );
    staleSecondFrame?.(16);
    frames.get(3)?.(16);
    const disposedSecondFrame = frames.get(4);

    expect(commitB).not.toHaveBeenCalled();
    page.remove();
    disposedSecondFrame?.(32);
    expect(commitC).not.toHaveBeenCalled();
  });
  it.each([
    { entry: "button", scope: "global" },
    { entry: "command", scope: "global" },
    { entry: "edge-drop", scope: "global" },
    { entry: "button", scope: "per-sender" },
    { entry: "command", scope: "per-sender" },
    { entry: "edge-drop", scope: "per-sender" },
  ] as const)(
    "preserves captured global ownership when creating a split via $entry ($scope)",
    async ({ entry, scope }) => {
      const workSessionKey = "agent:main:work";
      const page = new ChatPage();
      const { context } = setNavigationContext(page);
      context.agents.state.agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope,
        agents: [{ id: "main" }, { id: "research" }],
      };
      page.data = { sessionKey: "global", agentId: "research" };
      document.body.append(page);
      await page.updateComplete;
      if (entry === "button") {
        expectDefined(
          page.querySelector<RenderedPane>("openclaw-chat-pane"),
          "classic pane",
        ).onOpenSplitView?.();
      } else if (entry === "command") {
        window.dispatchEvent(
          new CustomEvent(UI_COMMAND_EVENT, {
            detail: {
              command: { kind: "split", direction: "right", sessionKey: workSessionKey },
              sessionKey: "global",
              agentId: "research",
            },
            cancelable: true,
          }),
        );
      } else {
        (
          page as unknown as {
            applySessionDrop: (
              key: string,
              pane: string,
              zone: { kind: "edge"; edge: "right" },
            ) => void;
          }
        ).applySessionDrop(workSessionKey, "p1", { kind: "edge", edge: "right" });
      }
      await page.updateComplete;
      expect(
        loadSettings().chatSplitLayout?.columns.map((column) => column.panes[0]?.sessionKey),
      ).toEqual([
        scope === "global" ? "agent:research:main" : "global",
        entry === "button"
          ? scope === "global"
            ? "agent:research:main"
            : "global"
          : workSessionKey,
      ]);
      expect(page.querySelector("[data-unbound-pane-id]")).toBeNull();
    },
  );
  it.each(["canonical replacement", "explicit command"] as const)(
    "distinguishes an %s from implicit pane recovery",
    async (reason) => {
      const page = new ChatPage();
      setNavigationContext(page);
      const key = "agent:main:12345678-90ab-cdef-1234-567890abcdef";
      const route = (title: string) =>
        sessionNavigationTarget({
          fallbackAgentId: "main",
          face: "chat",
          sessionKey: key,
          row: { key, displayName: title },
        }).href;
      window.history.replaceState({}, "", route("Old title"));
      page.data = { sessionKey: key };
      patchSettings({
        chatSplitLayout: {
          activePaneId: "known",
          columnWeights: [0.5, 0.5],
          columns: [
            { id: "c1", paneWeights: [1], panes: [{ id: "unknown", sessionKey: "global" }] },
            { id: "c2", paneWeights: [1], panes: [{ id: "known", sessionKey: key }] },
          ],
        },
      });
      document.body.append(page);
      await page.updateComplete;
      expectDefined(
        page.querySelector<HTMLElement>("[data-unbound-pane-id]"),
        "unknown pane",
      ).focus();
      await page.updateComplete;
      if (reason === "canonical replacement") {
        expect(route("New title")).not.toBe(route("Old title"));
        window.history.replaceState({}, "", route("New title"));
        page.data = { sessionKey: key };
      } else {
        window.dispatchEvent(
          new CustomEvent(UI_COMMAND_EVENT, {
            detail: { command: { kind: "navigate", sessionKey: key }, agentId: "main" },
            cancelable: true,
          }),
        );
      }
      await page.updateComplete;
      expect(loadSettings().chatSplitLayout?.columns[0]?.panes[0]?.sessionKey).toBe(
        reason === "canonical replacement" ? "global" : key,
      );
    },
  );

  it.each([false, true])(
    "fences the router read already pending when an unknown pane is focused (new choice: %s)",
    async (chooseAgain) => {
      const page = new ChatPage();
      const { context } = setNavigationContext(page);
      const initial: SessionChatRouteData = { sessionKey: "agent:main:a" };
      const destination: SessionChatRouteData = { sessionKey: "agent:main:b" };
      const entered = createDeferred();
      const release = createDeferred<SessionChatRouteData>();
      const router = createRouter<
        "chat" | "dashboard",
        ApplicationContext,
        Record<string, never>,
        SessionChatRouteData
      >({
        routes: [
          { id: "chat", path: "/chat", component: () => ({}), loader: () => initial },
          {
            id: "dashboard",
            path: "/pending",
            component: () => ({}),
            loader: () => {
              entered.resolve();
              return release.promise;
            },
          },
        ],
      });
      Object.assign(context, { router });
      window.history.replaceState({}, "", "/chat");
      const location = () => ({
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      });
      const unsubscribe = router.subscribe((state) => {
        const match = state.matches.find((entry) => entry.status === "success");
        if (match?.data) {
          page.data = match.data;
        }
      });
      let pending: Promise<void> | undefined;
      let replacement: Promise<void> | undefined;
      try {
        await router.start(
          {
            location,
            push: (next) =>
              window.history.pushState({}, "", next.pathname + next.search + next.hash),
            replace: (next) =>
              window.history.replaceState({}, "", next.pathname + next.search + next.hash),
            listen: () => () => {},
          },
          "",
          context,
        );
        patchSettings({
          chatSplitLayout: {
            activePaneId: "known",
            columnWeights: [0.5, 0.5],
            columns: [
              { id: "c1", paneWeights: [1], panes: [{ id: "unknown", sessionKey: "global" }] },
              {
                id: "c2",
                paneWeights: [1],
                panes: [{ id: "known", sessionKey: initial.sessionKey }],
              },
            ],
          },
        });
        document.body.append(page);
        await page.updateComplete;
        pending = router.navigate("dashboard", context);
        await entered.promise;
        expect(page.data).toBe(initial);
        expectDefined(
          page.querySelector<HTMLElement>("[data-unbound-pane-id]"),
          "unknown pane",
        ).focus();
        await page.updateComplete;
        if (chooseAgain) {
          const owner = Object.assign(document.createElement("nav"), {
            activeRouteId: "dashboard",
            sessionKey: destination.sessionKey,
          });
          document.body.append(owner);
          runSessionNavigationIntent(owner, {
            face: "chat",
            sessionKey: initial.sessionKey,
            agentId: "main",
            commit: () => {
              replacement = router.navigate("chat", context);
              return true;
            },
          });
          expect(loadSettings().chatSplitLayout?.columns[0]?.panes[0]?.sessionKey).toBe(
            initial.sessionKey,
          );
          await replacement;
        }
        release.resolve(destination);
        await pending;
        await page.updateComplete;
        expect(loadSettings().chatSplitLayout?.columns[0]?.panes[0]?.sessionKey).toBe(
          chooseAgain ? initial.sessionKey : "global",
        );
      } finally {
        release.resolve(destination);
        await Promise.allSettled([pending, replacement]);
        unsubscribe();
        router.stop();
        page.remove();
      }
    },
  );
});

/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-retained.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./chat-pane.ts", () => ({}));
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import type { GatewayHelloOk } from "../../api/gateway.ts";
import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import { SESSION_NAVIGATION_INTENT_EVENT } from "../../lib/sessions/navigation-handoff.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createChatPageSessions } from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";
import { CHAT_TRANSCRIPT_READY_EVENT } from "./chat-transcript-ready.ts";
import { routeDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";

type RenderedPane = HTMLElement & {
  active: boolean;
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
  preparing: boolean;
  transcriptCommitted: boolean;
  sessionKey: string;
};

function setNavigationContext(page: ChatPage) {
  const navigate = vi.fn();
  const replace = vi.fn();
  const patch = vi.fn(async () => null);
  const agentSelectionState = { selectedId: "main" };
  const chatAttachmentHandoff = {
    prepare: vi.fn(),
    consume: vi.fn(() => null),
    clearPane: vi.fn(),
    dispose: vi.fn(),
  };
  const context = {
    basePath: "",
    sessions: { ...createChatPageSessions(), patch },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: {
      snapshot: { hello: null },
      setSessionKey: vi.fn(),
      subscribe: () => () => undefined,
    },
    navigate,
    replace,
    agentSelection: {
      state: agentSelectionState,
      set: vi.fn((agentId: string) => {
        agentSelectionState.selectedId = agentId;
      }),
    },
    chatAttachmentHandoff,
  } as unknown as ApplicationContext;
  (page as unknown as { context: ApplicationContext }).context = context;
  return { chatAttachmentHandoff, context, navigate, patch, replace };
}

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

async function reportTranscriptReady(page: ChatPage, sessionKey: string): Promise<void> {
  const pane = expectDefined(
    [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")].find((candidate) =>
      areUiSessionKeysEquivalent(candidate.sessionKey, sessionKey),
    ),
    `pane for transcript-ready event: ${sessionKey}`,
  );
  pane.transcriptCommitted = true;
  pane.dispatchEvent(
    new CustomEvent(CHAT_TRANSCRIPT_READY_EVENT, {
      bubbles: true,
      composed: true,
      detail: { paneId: pane.paneId, sessionKey },
    }),
  );
  await page.updateComplete;
}

function setLayout(page: ChatPage, layout: ChatSplitLayout): void {
  (page as unknown as { layout: ChatSplitLayout }).layout = layout;
}

function splitLayout(
  activePaneId: "p1" | "p2",
  firstSessionKey: string,
  secondSessionKey: string,
): ChatSplitLayout {
  return {
    activePaneId,
    columns: [
      { id: "c1", panes: [{ id: "p1", sessionKey: firstSessionKey }], paneWeights: [1] },
      { id: "c2", panes: [{ id: "p2", sessionKey: secondSessionKey }], paneWeights: [1] },
    ],
    columnWeights: [0.5, 0.5],
  };
}

async function mountRetainedPage(sessionKey: string, ...warmSessionKeys: string[]) {
  const page = new ChatPage();
  const navigation = setNavigationContext(page);
  page.data = { sessionKey };
  document.body.append(page);
  await page.updateComplete;
  await reportTranscriptReady(page, sessionKey);
  for (const key of warmSessionKeys) {
    await showSession(page, key);
    await reportTranscriptReady(page, key);
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
    expect(context.agentSelection.set).toHaveBeenLastCalledWith("research");
    page
      .querySelector<HTMLElement>(".chat-split-view__cell")
      ?.dispatchEvent(new Event("pointerdown"));
    await page.updateComplete;

    expect(context.gateway.setSessionKey).toHaveBeenLastCalledWith(workSessionKey);
    expect(loadSettings()).toMatchObject({
      sessionKey: workSessionKey,
      lastActiveSessionKey: workSessionKey,
    });
    expect(context.agentSelection.set).toHaveBeenLastCalledWith("main");
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
    await reportTranscriptReady(page, "agent:main:b");
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

      Object.defineProperties(pane, {
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

  it("presents a retained sidebar destination before route data resolves", async () => {
    const { page, paneFor, panes } = await mountRetainedPage(
      "agent:main:a",
      "agent:main:b",
      "agent:main:a",
    );
    const paneA = paneFor("agent:main:a");
    const paneB = paneFor("agent:main:b");

    const intent = new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
      cancelable: true,
      detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
    });
    window.dispatchEvent(intent);
    await page.updateComplete;

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
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:a" },
      }),
    );
    await page.updateComplete;
    expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
    expect(paneA?.presented).toBe(true);
    expect(paneA?.hasAttribute("inert")).toBe(false);
    expect(paneB?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
    expect(paneB?.presented).toBe(false);
    expect(paneB?.hasAttribute("inert")).toBe(true);

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
      }),
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    await page.updateComplete;
    expect(paneA?.presented).toBe(true);
    expect(paneB?.presented).toBe(false);

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
      }),
    );
    page.data = { sessionKey: "agent:main:b" };
    await page.updateComplete;
    await page.updateComplete;
    expect(panes().find((pane) => pane.sessionKey === "agent:main:b")).toBe(paneB);
    expect(paneA?.active).toBe(false);
    expect(paneA?.presented).toBe(false);
    expect(paneA?.hasAttribute("inert")).toBe(true);
    expect(paneB?.active).toBe(true);
    expect(paneB?.presented).toBe(true);
    expect(paneB?.hasAttribute("inert")).toBe(false);
  });

  it("keeps the previous transcript visible until a cold destination is ready", async () => {
    const { page, paneFor } = await mountRetainedPage("agent:main:a");
    const paneA = paneFor("agent:main:a");

    const intent = new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
      cancelable: true,
      detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
    });
    window.dispatchEvent(intent);
    expect(intent.defaultPrevented).toBe(false);
    await page.updateComplete;
    expect(page.querySelector('.chat-pane-cache[aria-busy="true"]')).not.toBeNull();
    expect(paneA?.hasAttribute("inert")).toBe(true);

    await showSession(page, "agent:main:b");
    const paneB = paneFor("agent:main:b");
    expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
    expect(paneA?.presented).toBe(true);
    expect(paneB?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
    expect(paneB?.presented).toBe(false);
    expect(paneA?.hasAttribute("inert")).toBe(true);
    expect(paneB?.hasAttribute("inert")).toBe(true);

    if (paneB) {
      paneB.transcriptCommitted = true;
    }
    paneB?.dispatchEvent(
      new CustomEvent(CHAT_TRANSCRIPT_READY_EVENT, {
        bubbles: true,
        composed: true,
        detail: { paneId: "p1", sessionKey: "agent:main:b" },
      }),
    );
    await page.updateComplete;

    expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
    expect(paneA?.presented).toBe(false);
    expect(paneB?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
    expect(paneB?.presented).toBe(true);
    expect(page.querySelector('.chat-pane-cache[aria-busy="true"]')).toBeNull();
  });

  it("defers route draft focus until a cold destination is presented", async () => {
    const { page, paneFor } = await mountRetainedPage("agent:main:a");
    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
      }),
    );

    page.data = {
      sessionKey: "agent:main:b",
      draft: "Continue in session B",
      focusComposer: true,
    };
    await page.updateComplete;
    const paneB = expectDefined(paneFor("agent:main:b"), "cold destination pane");

    expect(paneB.presented).toBe(false);
    expect(paneB.draft).toBeUndefined();
    expect(paneB.focusComposer).toBe(false);
    const receivedDrafts: Array<string | undefined> = [];
    const focusRequests: boolean[] = [];
    Object.defineProperties(paneB, {
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

    paneB.transcriptCommitted = true;
    paneB.dispatchEvent(
      new CustomEvent(CHAT_TRANSCRIPT_READY_EVENT, {
        bubbles: true,
        composed: true,
        detail: { paneId: "p1", sessionKey: "agent:main:b" },
      }),
    );
    await page.updateComplete;

    expect(paneB.presented).toBe(true);
    expect(receivedDrafts).toContain("Continue in session B");
    expect(focusRequests).toContain(true);
  });

  it("keeps the original transcript visible when a cold destination is superseded", async () => {
    const { page, paneFor, panes } = await mountRetainedPage("agent:main:a");
    const paneA = paneFor("agent:main:a");

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
      }),
    );
    await showSession(page, "agent:main:b");
    const paneB = paneFor("agent:main:b");

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:c" },
      }),
    );
    await showSession(page, "agent:main:c");
    const paneC = paneFor("agent:main:c");

    expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
    expect(paneB?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
    expect(paneC?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:d" },
      }),
    );
    await showSession(page, "agent:main:d");
    const paneD = paneFor("agent:main:d");

    expect(panes().map((pane) => pane.sessionKey)).toEqual([
      "agent:main:a",
      "agent:main:c",
      "agent:main:d",
    ]);
    expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
    expect(paneD?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
  });

  it("keeps a superseded target hidden when it becomes ready and warms its revisit", async () => {
    const { page, paneFor } = await mountRetainedPage("agent:main:a");

    for (const sessionKey of ["agent:main:b", "agent:main:c"]) {
      window.dispatchEvent(
        new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
          cancelable: true,
          detail: { commit: () => true, face: "chat", sessionKey },
        }),
      );
      await showSession(page, sessionKey);
    }

    await reportTranscriptReady(page, "agent:main:b");
    expect(paneFor("agent:main:a")?.classList.contains("chat-pane-cache__pane--visible")).toBe(
      true,
    );
    expect(paneFor("agent:main:b")?.classList.contains("chat-pane-cache__pane--visible")).toBe(
      false,
    );
    expect(paneFor("agent:main:c")?.classList.contains("chat-pane-cache__pane--visible")).toBe(
      false,
    );

    const revisit = new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
      cancelable: true,
      detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
    });
    window.dispatchEvent(revisit);
    await page.updateComplete;

    expect(revisit.defaultPrevented).toBe(true);
    expect(paneFor("agent:main:b")?.classList.contains("chat-pane-cache__pane--visible")).toBe(
      true,
    );
  });

  it("keeps cold transitions independent across split panes", async () => {
    const page = new ChatPage();
    setNavigationContext(page);
    page.data = { sessionKey: "agent:main:a" };
    document.body.append(page);
    setLayout(page, splitLayout("p1", "agent:main:a", "agent:main:c"));
    await page.updateComplete;
    await reportTranscriptReady(page, "agent:main:a");
    await reportTranscriptReady(page, "agent:main:c");

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
      }),
    );
    setLayout(page, splitLayout("p1", "agent:main:b", "agent:main:c"));
    await showSession(page, "agent:main:b");

    setLayout(page, splitLayout("p2", "agent:main:b", "agent:main:c"));
    await showSession(page, "agent:main:c");
    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:d" },
      }),
    );
    setLayout(page, splitLayout("p2", "agent:main:b", "agent:main:d"));
    await showSession(page, "agent:main:d");

    const panes = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
    const visibleSessions = panes
      .filter((pane) => pane.classList.contains("chat-pane-cache__pane--visible"))
      .map((pane) => pane.sessionKey)
      .toSorted();
    expect(visibleSessions).toEqual(["agent:main:a", "agent:main:c"]);
    const paneB = expectDefined(
      panes.find((pane) => pane.sessionKey === "agent:main:b"),
      "preparing sibling",
    );
    expect(paneB.active).toBe(false);
    expect(paneB.preparing).toBe(true);
    Object.assign(page, { narrow: true });
    await page.updateComplete;
    expect(paneB.preparing).toBe(false);
    Object.assign(page, { narrow: false });
    await reportTranscriptReady(page, "agent:main:b");
    expect(
      panes
        .filter((pane) => pane.presented)
        .map((pane) => pane.sessionKey)
        .toSorted(),
    ).toEqual(["agent:main:b", "agent:main:c"]);
    await reportTranscriptReady(page, "agent:main:d");
    expect(
      panes
        .filter((pane) => pane.presented)
        .map((pane) => pane.sessionKey)
        .toSorted(),
    ).toEqual(["agent:main:b", "agent:main:d"]);
  });

  it("reveals a cold loading pane after the bounded delay", async () => {
    vi.useFakeTimers();
    try {
      const { page, paneFor } = await mountRetainedPage("agent:main:a");
      window.dispatchEvent(
        new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
          cancelable: true,
          detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
        }),
      );
      await showSession(page, "agent:main:b");
      const paneA = paneFor("agent:main:a");
      const paneB = paneFor("agent:main:b");

      vi.advanceTimersByTime(749);
      await page.updateComplete;
      expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);

      vi.advanceTimersByTime(1);
      await page.updateComplete;
      expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
      expect(paneB?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reveals a cold destination when its visible source is deleted", async () => {
    const { navigation, page, paneFor, panes } = await mountRetainedPage("agent:main:a");
    const paneA = paneFor("agent:main:a");

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
      }),
    );
    await showSession(page, "agent:main:b");
    const paneB = paneFor("agent:main:b");
    navigation.navigate.mockClear();

    paneA?.onSessionDeleted?.("p1", "agent:main:a", "agent:main:main");
    await page.updateComplete;

    expect(panes().some((pane) => pane.sessionKey === "agent:main:a")).toBe(false);
    expect(paneB?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("does not retain an unfinished fallback when its navigation is superseded", async () => {
    vi.useFakeTimers();
    try {
      const { page, paneFor } = await mountRetainedPage("agent:main:a");
      await showSession(page, "agent:main:b");
      vi.advanceTimersByTime(750);
      await page.updateComplete;
      await showSession(page, "agent:main:c");
      await reportTranscriptReady(page, "agent:main:b");
      expect(paneFor("agent:main:b")?.presented).toBe(false);
      expect(paneFor("agent:main:c")?.presented).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a cancelled preview inactive after its split cell becomes mobile-hidden", async () => {
    vi.useFakeTimers();
    try {
      const { page, paneFor } = await mountRetainedPage(
        "agent:main:a",
        "agent:main:b",
        "agent:main:a",
      );
      window.dispatchEvent(
        new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
          cancelable: true,
          detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
        }),
      );
      setLayout(page, splitLayout("p2", "agent:main:a", "agent:main:c"));
      Object.assign(page, { narrow: true });
      await page.updateComplete;
      vi.advanceTimersByTime(5_000);
      await page.updateComplete;
      expect(paneFor("agent:main:a")?.presented).toBe(false);
      expect(paneFor("agent:main:a")?.getAttribute("aria-hidden")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the source visible when a cold destination is replaced after deletion", async () => {
    const { page, paneFor, panes } = await mountRetainedPage("agent:main:a");
    const paneA = paneFor("agent:main:a");

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
      }),
    );
    await showSession(page, "agent:main:b");
    paneFor("agent:main:b")?.onSessionDeleted?.("p1", "agent:main:b", "agent:main:c");
    await showSession(page, "agent:main:c");
    const paneC = paneFor("agent:main:c");

    expect(panes().some((pane) => pane.sessionKey === "agent:main:b")).toBe(false);
    expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
    expect(paneC?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
  });

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

  it("rolls a retained preview back when authoritative navigation never commits", async () => {
    vi.useFakeTimers();
    try {
      const { page, paneFor } = await mountRetainedPage(
        "agent:main:a",
        "agent:main:b",
        "agent:main:a",
      );
      const paneA = paneFor("agent:main:a");
      const paneB = paneFor("agent:main:b");

      window.dispatchEvent(
        new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
          cancelable: true,
          detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
        }),
      );
      await page.updateComplete;
      expect(paneA?.presented).toBe(true);
      expect(paneA?.hasAttribute("inert")).toBe(true);
      expect(paneB?.presented).toBe(false);
      expect(paneB?.hasAttribute("inert")).toBe(true);
      vi.advanceTimersByTime(5_000);
      await page.updateComplete;

      expect(paneA?.presented).toBe(true);
      expect(paneA?.hasAttribute("inert")).toBe(false);
      expect(paneB?.presented).toBe(false);
      expect(paneB?.hasAttribute("inert")).toBe(true);
    } finally {
      vi.useRealTimers();
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
});

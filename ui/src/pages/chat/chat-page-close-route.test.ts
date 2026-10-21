/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-close.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

// mock-isolation: Control delayed route handoff with fake pane bindings, without the real tag's session startup.
vi.mock("./chat-pane.tsx", async () => {
  const { mockChatPagePane } = await import("./chat-page-pane.test-support.ts");
  return { ChatPaneView: mockChatPagePane };
});
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { UI_COMMAND_EVENT, type UiCommandDetail } from "../../components/panel-toggle-contract.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createChatPageNavigationContext,
  settleChatPage,
  setNavigationContext,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import "./chat-page.tsx";
import type { ChatRouteData } from "./route-loader.ts";
import { ChatRouteView } from "./route-view.tsx";
import type { SessionChatRouteData } from "./session-route-data.ts";

type RenderedPane = HTMLElement & {
  active: boolean;
  paneId: string;
  presented: boolean;
  sessionKey: string;
  routeFace: "chat" | "dashboard";
  onPaneSessionChange?: (
    paneId: string,
    sessionKey: string,
    options?: { replace?: boolean },
  ) => boolean | void;
  onClosePane?: (paneId: string) => void;
  onOpenSplitView?: () => void;
};

const panesIn = (page: HTMLElementTagNameMap["openclaw-chat-page"]) => [
  ...page.querySelectorAll<RenderedPane>("openclaw-chat-pane"),
];
function command(detail: UiCommandDetail) {
  window.dispatchEvent(new CustomEvent(UI_COMMAND_EVENT, { cancelable: true, detail }));
}
async function showSession(
  page: HTMLElementTagNameMap["openclaw-chat-page"],
  sessionKey: string,
): Promise<void> {
  page.data = { sessionKey };
  await settleChatPage(page);
  await settleChatPage(page);
}

describe("chat page close navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    stubMatchMedia(false);
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("keeps the page and warm pane through the outlet's route adapter and presentation changes", async () => {
    const firstKey = "agent:main:main";
    const nextKey = "agent:research:review";
    const { context } = createChatPageNavigationContext();
    const provider = createSolidApplicationContextProvider(context);
    const container = document.body.appendChild(createApplicationContextProvider(context));
    const [route, setRoute] = createSignal<{ data?: ChatRouteData; presented: boolean }>({
      presented: true,
    });
    const view = mountSolid(
      () =>
        createComponent(ChatRouteView, {
          get data() {
            return route().data;
          },
          get presented() {
            return route().presented;
          },
        }),
      { container, wrapper: provider.wrapper },
    );
    setRoute({ data: { kind: "session", sessionKey: firstKey, face: "chat" }, presented: true });
    await Promise.resolve();
    flush();
    const page = expectDefined(
      view.container.querySelector("openclaw-chat-page"),
      "openclaw-chat-page",
    );
    await settleChatPage(page);
    expect(panesIn(page).map((pane) => pane.sessionKey)).toEqual([firstKey]);
    const firstPane = expectDefined(
      page.querySelector<RenderedPane>("openclaw-chat-pane"),
      "openclaw-chat-pane",
    );

    for (const presented of [false, true]) {
      setRoute({
        data: { kind: "session", sessionKey: nextKey, face: "dashboard" },
        presented,
      });
      flush();
      await settleChatPage(page);
      expect(view.container.querySelector("openclaw-chat-page")).toBe(page);
      expect(page.presented).toBe(presented);
      expect(page.contains(firstPane)).toBe(true);
    }
    const nextPane = expectDefined(
      panesIn(page).find((pane) => pane.sessionKey === nextKey),
      "replacement route pane",
    );
    expect(nextPane).toMatchObject({ presented: true, routeFace: "dashboard" });
    view.unmount();
  });

  it("preserves a pending Home draft when its bound pane adopts the global wire key after collapsing", async () => {
    const page = document.createElement("openclaw-chat-page");
    const { context, navigate, replace } = setNavigationContext(page);
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main" }, { id: "research" }],
    };
    page.data = { sessionKey: "agent:main:main", agentId: "main" };
    document.body.append(page);
    await settleChatPage(page);
    const pane = expectDefined(
      page.querySelector<RenderedPane>("openclaw-chat-pane"),
      "openclaw-chat-pane",
    );
    pane.onOpenSplitView?.();
    await settleChatPage(page);
    const added = expectDefined(
      panesIn(page).find((candidate) => candidate !== pane),
      "second split pane",
    );
    added.onClosePane?.(added.paneId);
    await settleChatPage(page);
    await settleChatPage(page);
    expect(loadSettings().chatSplitLayout).toBeUndefined();
    expect(page.querySelector("openclaw-chat-pane")).toBe(pane);
    navigate.mockClear();
    replace.mockClear();
    const draft = {
      sessionKey: "agent:main:main",
      agentId: "main",
      draft: "What can you do?",
    };
    page.data = draft;

    expect(pane.onPaneSessionChange?.(pane.paneId, "global", { replace: true })).toBe(true);

    expect(navigate).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(page.data).toBe(draft);
  });

  it.each([false, true])(
    "does not retain a closed pane's route while the survivor loads (newer navigation: %s)",
    async (navigateAgain) => {
      const keys = ["agent:main:a", "agent:main:b", "agent:main:c"] as const;
      const data = keys.map((sessionKey) => ({ sessionKey, agentId: "main" }));
      const pathname = (sessionKey: string) =>
        expectDefined(
          sessionNavigationTarget({ face: "chat", sessionKey, fallbackAgentId: "main" }).options
            .pathname,
          "synthetic session path",
        );
      const page = document.createElement("openclaw-chat-page");
      const { context, replace } = setNavigationContext(page);
      const entered = createDeferred();
      const release = createDeferred<SessionChatRouteData>();
      let holdSurvivor = false;
      const router = createRouter<
        "chat",
        ApplicationContext,
        Record<string, never>,
        SessionChatRouteData
      >({
        routes: [
          {
            id: "chat",
            path: "/chat",
            component: () => ({}),
            loaderDeps: (_context, location) => location.pathname,
            loader: (_context, { location }) => {
              const selected =
                location.pathname === "/chat"
                  ? data[0]
                  : data.find((entry) => pathname(entry.sessionKey) === location.pathname);
              if (holdSurvivor && selected?.sessionKey === keys[0]) {
                entered.resolve();
                return release.promise;
              }
              return expectDefined(selected, "synthetic route");
            },
          },
        ],
      });
      Object.assign(context, { router });
      const navigations: Promise<void>[] = [];
      replace.mockImplementation((_routeId, options) => {
        navigations.push(
          router.navigate(
            "chat",
            context,
            { history: "replace" },
            {
              pathname: options?.pathname ?? "/chat",
              search: options?.search ?? "",
              hash: options?.hash ?? "",
            },
          ),
        );
      });
      const previousHref = window.location.href;
      window.history.replaceState({}, "", "/chat");
      const unsubscribe = router.subscribe((next) => {
        const match = next.matches.find((entry) => entry.status === "success");
        if (match?.data) {
          page.data = match.data;
        }
      });
      const panes = () => panesIn(page);
      try {
        await router.start(
          {
            location: () => ({ pathname: window.location.pathname, search: "", hash: "" }),
            push: (next) =>
              window.history.pushState({}, "", next.pathname + next.search + next.hash),
            replace: (next) =>
              window.history.replaceState({}, "", next.pathname + next.search + next.hash),
            listen: () => () => {},
          },
          "",
          context,
        );
        document.body.append(page);
        await settleChatPage(page);
        const survivor = expectDefined(panes()[0], "original survivor");
        command({
          command: { kind: "split", direction: "right", sessionKey: keys[1] },
          sessionKey: keys[0],
        });
        await expectDefined(navigations.at(-1), "split navigation");
        await settleChatPage(page);
        const closing = expectDefined(
          panes().find((pane) => pane.sessionKey === keys[1]),
          "closing pane",
        );
        holdSurvivor = true;
        expectDefined(closing.onClosePane, "registered close action")(closing.paneId);
        await entered.promise;
        await settleChatPage(page);

        expect(panes()).toEqual([survivor]);
        expect(closing.isConnected).toBe(false);
        expect(survivor.presented).toBe(true);
        expect(survivor.classList.contains("chat-split-view__pane")).toBe(false);
        expect(survivor.onClosePane).toBeUndefined();
        expect(survivor.onOpenSplitView).toBeTypeOf("function");
        expect(loadSettings().chatSplitLayout).toBeUndefined();

        page.presented = false;
        await settleChatPage(page);
        page.presented = true;
        await settleChatPage(page);
        command({ command: { kind: "close-pane", sessionKey: keys[0] } });
        await settleChatPage(page);
        expect(panes()).toEqual([survivor]);

        if (navigateAgain) {
          navigations.push(
            router.navigate(
              "chat",
              context,
              { history: "push" },
              {
                pathname: pathname(keys[2]),
                search: "",
                hash: "",
              },
            ),
          );
          await navigations.at(-1);
        }
        release.resolve(expectDefined(data[0], "survivor route"));
        await Promise.all(navigations);
        await settleChatPage(page);
        await settleChatPage(page);
        expect(panes().some((pane) => pane.sessionKey === keys[1])).toBe(false);
        expect(panes().find((pane) => pane.sessionKey === keys[0])).toBe(survivor);
        expect(panes().find((pane) => pane.active)?.sessionKey).toBe(keys[navigateAgain ? 2 : 0]);
        expect(page.querySelector(".chat-split-view__pane")).toBeNull();
      } finally {
        release.resolve(expectDefined(data[0], "survivor cleanup"));
        await Promise.allSettled(navigations);
        unsubscribe();
        router.stop();
        page.remove();
        window.history.replaceState({}, "", previousHref);
      }
    },
  );

  it("keeps a saved singleton's pane identity after explicit route admission", async () => {
    const page = document.createElement("openclaw-chat-page");
    setNavigationContext(page);
    page.data = { sessionKey: "agent:main:previous" };
    patchSettings({
      chatSplitLayout: {
        columns: [
          {
            id: "saved-column",
            panes: [{ id: "saved-pane", sessionKey: "global" }],
            paneWeights: [1],
          },
        ],
        columnWeights: [1],
        activePaneId: "saved-pane",
      },
    });
    document.body.append(page);
    await settleChatPage(page);
    expect(page.querySelector('[data-unbound-pane-id="saved-pane"]')).not.toBeNull();
    const sessionKey = "agent:research:chosen";
    command({ command: { kind: "navigate", sessionKey }, agentId: "research" });
    await settleChatPage(page);
    const admitted = expectDefined(
      page.querySelector<RenderedPane>("openclaw-chat-pane"),
      "openclaw-chat-pane",
    );
    expect(admitted.paneId).toBe("saved-pane");
    await showSession(page, sessionKey);
    expect(page.querySelector("openclaw-chat-pane")).toBe(admitted);
    expect(admitted.active).toBe(true);
    expect(admitted.classList.contains("chat-split-view__pane")).toBe(false);
    expect(admitted.onOpenSplitView).toBeTypeOf("function");
  });
});

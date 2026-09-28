/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-close.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

vi.mock("./chat-pane.ts", () => ({}));
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { setNavigationContext, stubMatchMedia } from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";
import type { SessionChatRouteData } from "./session-route-data.ts";

type RenderedPane = HTMLElement & {
  active: boolean;
  paneId: string;
  presented: boolean;
  sessionKey: string;
  onClosePane?: (paneId: string) => void;
  onOpenSplitView?: () => void;
};

async function showSession(page: ChatPage, sessionKey: string): Promise<void> {
  page.data = { sessionKey };
  await page.updateComplete;
  await page.updateComplete;
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
      const page = new ChatPage();
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
      const panes = () => [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
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
        await page.updateComplete;
        const survivor = expectDefined(panes()[0], "original survivor");
        window.dispatchEvent(
          new CustomEvent(UI_COMMAND_EVENT, {
            cancelable: true,
            detail: {
              command: { kind: "split", direction: "right", sessionKey: keys[1] },
              sessionKey: keys[0],
            },
          }),
        );
        await expectDefined(navigations.at(-1), "split navigation");
        await page.updateComplete;
        const closing = expectDefined(
          panes().find((pane) => pane.sessionKey === keys[1]),
          "closing pane",
        );
        holdSurvivor = true;
        expectDefined(closing.onClosePane, "registered close action")(closing.paneId);
        await entered.promise;
        await page.updateComplete;

        expect(panes()).toEqual([survivor]);
        expect(closing.isConnected).toBe(false);
        expect(survivor.presented).toBe(true);
        expect(survivor.classList.contains("chat-split-view__pane")).toBe(false);
        expect(survivor.onClosePane).toBeUndefined();
        expect(survivor.onOpenSplitView).toBeTypeOf("function");
        expect(loadSettings().chatSplitLayout).toBeUndefined();

        page.presented = false;
        await page.updateComplete;
        page.presented = true;
        await page.updateComplete;
        window.dispatchEvent(
          new CustomEvent(UI_COMMAND_EVENT, {
            cancelable: true,
            detail: { command: { kind: "close-pane", sessionKey: keys[0] } },
          }),
        );
        await page.updateComplete;
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
        await page.updateComplete;
        await page.updateComplete;
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
    const page = new ChatPage();
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
    await page.updateComplete;
    expect(page.querySelector('[data-unbound-pane-id="saved-pane"]')).not.toBeNull();
    const sessionKey = "agent:research:chosen";
    window.dispatchEvent(
      new CustomEvent(UI_COMMAND_EVENT, {
        cancelable: true,
        detail: { command: { kind: "navigate", sessionKey }, agentId: "research" },
      }),
    );
    await page.updateComplete;
    const admitted = expectDefined(
      page.querySelector<RenderedPane>("openclaw-chat-pane"),
      "admitted pane",
    );
    expect(admitted.paneId).toBe("saved-pane");
    await showSession(page, sessionKey);
    expect(page.querySelector("openclaw-chat-pane")).toBe(admitted);
    expect(admitted.active).toBe(true);
    expect(admitted.classList.contains("chat-split-view__pane")).toBe(false);
    expect(admitted.onOpenSplitView).toBeTypeOf("function");
  });
});

/* @vitest-environment jsdom */
import { createRouter, definePage } from "@openclaw/uirouter";
import { afterEach, expect, it, vi } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import {
  createChatPageNavigationContext,
  settleChatPage,
  stubMatchMedia,
} from "../pages/chat/chat-page.test-support.ts";
import type { ChatPage } from "../pages/chat/chat-page.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import type { ApplicationContext } from "./context.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";
import { settleRouterOutlet } from "./router-outlet.test-support.tsx";
import { RouterOutlet } from "./router-outlet.tsx";

// mock-isolation: Observe the real page's pane bindings without starting pane domain owners.
vi.mock("../pages/chat/chat-pane.tsx", async () => {
  const { mockChatPagePane } = await import("../pages/chat/chat-page-pane.test-support.ts");
  return { ChatPaneView: mockChatPagePane };
});

afterEach(() => vi.unstubAllGlobals());

it("mounts one pane for the legacy chat route and retains it through revalidation", async () => {
  const chatRoute = await import("../pages/chat/route-entry.ts");
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  stubMatchMedia(false);
  const { context } = createChatPageNavigationContext();
  const sessionKey = "agent:main:main";
  const router = createRouter<RouteId, ApplicationContext, typeof chatRoute>({
    routes: [
      definePage<RouteId, ApplicationContext, typeof chatRoute>({
        id: "chat",
        path: "/chat",
        loader: () => ({
          kind: "session",
          sessionKey,
          agentId: "main",
          face: "chat",
          shortId: "main",
        }),
        component: () => chatRoute,
      }),
    ],
  });
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <RouterOutlet router={router} retryContext={context} />
    </ApplicationProvider>
  ));
  try {
    await router.navigate("chat", context);
    const outlet =
      view.container.querySelector<ControlUiReadinessOutlet>("openclaw-router-outlet")!;
    await settleRouterOutlet(outlet);
    const page = outlet.querySelector<ChatPage>("openclaw-chat-page")!;
    expect(page).not.toBeNull();
    await settleChatPage(page);
    const pane = page.querySelector<HTMLElement & { sessionKey: string }>("openclaw-chat-pane")!;
    expect(page.querySelectorAll("openclaw-chat-pane")).toHaveLength(1);
    expect(pane.sessionKey).toBe(sessionKey);

    await router.navigate("chat", context, { revalidate: true });
    await settleRouterOutlet(outlet);
    await settleChatPage(page);
    expect(outlet.querySelector("openclaw-chat-page")).toBe(page);
    expect(page.querySelectorAll("openclaw-chat-pane")).toHaveLength(1);
    expect(page.querySelector("openclaw-chat-pane")).toBe(pane);
    expect(pane.sessionKey).toBe(sessionKey);
  } finally {
    view.unmount();
    router.stop();
  }
});

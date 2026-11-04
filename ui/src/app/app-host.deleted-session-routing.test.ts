/* @vitest-environment jsdom */
import { createRouter, type RouterHistory } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import type { ApplicationRouter } from "../app-routes.ts";
import { pages as chatPages } from "../pages/chat/route.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import { bootstrapApplication } from "./bootstrap.ts";

setupSidebarTest();

it.each([false, true])("recovers deleted Chat once (reconnect: %s)", async (reconnect) => {
  vi.stubGlobal("requestIdleCallback", vi.fn());
  const application = bootstrapApplication();
  const { context } = application;
  const mainKey = "agent:main:main";
  const deletedKey = "agent:main:deleted-thread";
  let location = { pathname: "/chat/main/deleted-thread", search: "", hash: "" };
  const history: RouterHistory = {
    location: () => location,
    push: (next) => {
      location = next;
    },
    replace: (next) => {
      location = next;
    },
    listen: () => () => {},
  };
  const routes: ApplicationRouter["routes"] = [
    {
      id: "chat",
      path: "/chat/main",
      aliases: ["/chat/main/deleted-thread"],
      loaderDeps: chatPages[0].loaderDeps,
      component: () => ({ renderSolid: () => null }),
      loader: (_context, options) => ({
        kind: "session",
        sessionKey: options.location.pathname === "/chat/main" ? mainKey : deletedKey,
      }),
    },
  ];
  const router = createRouter({ routes });
  const subscribe = router.subscribe.bind(router);
  let notifyRoute = () => {};
  vi.spyOn(router, "subscribe").mockImplementation((listener) => {
    notifyRoute = () => listener(router.getState());
    return subscribe(listener);
  });
  let recovery: Promise<void> | undefined;
  const errors: unknown[] = [];
  const replace = vi.spyOn(context, "replace").mockImplementation((routeId, options) => {
    recovery = router.navigate(
      routeId,
      context,
      { history: "replace" },
      {
        ...location,
        ...options,
      },
    );
    void recovery.catch((error: unknown) => errors.push(error));
  });
  const deletion = vi.spyOn(context.sessions, "deletionState");
  const shell = createShellOwner();
  shell.runtime = { ...application, router };
  try {
    await router.start(history, "", context);
    shell.connect();
    expect(shell.activeSessionKey).toBe(deletedKey);
    if (reconnect) {
      shell.disconnect();
      shell.connect();
    }
    expect(shell.lastWorkspaceLocation?.pathname).toBe("/chat/main/deleted-thread");
    const invalidate = vi.spyOn(shell, "invalidate");
    notifyRoute();
    expect(invalidate).not.toHaveBeenCalled();

    deletion.mockImplementation((key) => (key === deletedKey ? "confirmed" : undefined));
    shell.shellNavigation.recoverDeletedActiveSession();
    await recovery;

    expect(errors).toEqual([]);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
    expect(location.pathname).toBe("/chat/main");
    expect(shell.activeSessionKey).toBe(mainKey);
    expect(context.gateway.snapshot.sessionKey).toBe(mainKey);
  } finally {
    shell.disconnect();
    router.stop();
    application.stop();
  }
});

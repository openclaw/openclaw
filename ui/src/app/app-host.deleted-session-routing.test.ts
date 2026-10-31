/* @vitest-environment jsdom */
import { createRouter, type RouterHistory } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import type { ApplicationRouter } from "../app-routes.ts";
import { pages as chatPages } from "../pages/chat/route.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import { bootstrapApplication } from "./bootstrap.ts";

setupSidebarTest();

const cases = [false, true, "literal"] as const;
it.each(cases)("recovers deleted Chat once (mode: %s)", async (mode) => {
  vi.stubGlobal("requestIdleCallback", vi.fn());
  const application = bootstrapApplication();
  const { context } = application;
  const mainKey = "agent:main:main";
  const literal = mode === "literal";
  const deletedKey = literal ? "agent:main:global" : "agent:main:deleted-thread";
  const deletedPath = literal ? "/chat/main/~key/global" : "/chat/main/deleted-thread";
  let location = { pathname: deletedPath, search: "", hash: "" };
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
      aliases: [deletedPath],
      loaderDeps: chatPages[0].loaderDeps,
      component: () => ({ renderSolid: () => null }),
      loader: (routeContext, options) =>
        literal && routeContext.sessions.deletionState(deletedKey) === "confirmed"
          ? chatPages[0].loader!(routeContext, options)
          : {
              kind: "session",
              sessionKey: options.location.pathname === "/chat/main" ? mainKey : deletedKey,
            },
    },
  ];
  const router = createRouter({ routes });
  Object.assign(context, { router });
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
  const revalidate = vi.spyOn(context, "revalidate").mockImplementation((routeId) => {
    recovery = router.revalidate(context, routeId);
    void recovery.catch((error: unknown) => errors.push(error));
    return recovery;
  });
  const deletion = vi.spyOn(context.sessions, "deletionState");
  const shell = createShellOwner();
  shell.runtime = { ...application, router };
  try {
    await router.start(history, "", context);
    shell.connect();
    expect(shell.activeSessionKey).toBe(deletedKey);
    if (mode === true) {
      shell.disconnect();
      shell.connect();
    }
    expect(shell.lastWorkspaceLocation?.pathname).toBe(deletedPath);
    const invalidate = vi.spyOn(shell, "invalidate");
    notifyRoute();
    expect(invalidate).not.toHaveBeenCalled();

    deletion.mockImplementation((key) => (key === deletedKey ? "confirmed" : undefined));
    shell.shellNavigation.recoverDeletedActiveSession();
    await recovery;

    expect(errors).toEqual([]);
    if (literal) {
      shell.shellNavigation.recoverDeletedActiveSession();
      expect(revalidate).toHaveBeenCalledExactlyOnceWith("chat");
      expect(replace).not.toHaveBeenCalled();
      expect(router.getState().matches[0]?.data).toMatchObject({ kind: "missing-session" });
      expect(location.pathname).toBe(deletedPath);
      expect(shell.activeSessionKey).toBe(deletedKey);
      expect(context.gateway.snapshot.sessionKey).toBe(deletedKey);
      return;
    }
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

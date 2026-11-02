// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { createSessionRouteContext } from "./route-resolution.test-support.ts";
import { pages } from "./route.ts";

const runtime = vi.hoisted(() => ({
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  boardStarted: vi.fn(),
  boardReady: Promise.withResolvers<void>(),
  boardRelease: Promise.withResolvers<void>(),
  sidebarStarted: vi.fn(),
  sidebarReady: Promise.withResolvers<void>(),
  sidebarRelease: Promise.withResolvers<void>(),
}));

vi.mock("../../lib/sessions/session-message-subscriptions.runtime.ts", async (importOriginal) => {
  runtime.started.resolve();
  await runtime.release.promise;
  return importOriginal();
});

// mock-isolation: Hold the lazy view unresolved to prove navigation does not wait for it.
vi.mock("../../components/board/board-view.tsx", async () => {
  runtime.boardStarted();
  runtime.boardReady.resolve();
  await runtime.boardRelease.promise;
  return {};
});

// mock-isolation: Hold the sidebar unresolved independently without mounting its observers.
vi.mock("./components/chat-sidebar-region.runtime.tsx", async () => {
  runtime.sidebarStarted();
  runtime.sidebarReady.resolve();
  await runtime.sidebarRelease.promise;
  return {};
});

it("preloads subscriptions and dashboard presentation without waiting or opening observers", async () => {
  const { context, request } = createSessionRouteContext();
  const load = async (page: (typeof pages)[number]) => {
    const location = { pathname: `/${page.id}/roboclaw/main`, search: "", hash: "" };
    return page.loader!(
      context,
      createRouteLoaderOptions(location, page.loaderDeps!(context, location)),
    );
  };
  const loads = [load(pages[0])];
  try {
    await runtime.started.promise;
    await expect(loads[0]).resolves.toMatchObject({
      kind: "session",
      sessionKey: "agent:roboclaw:main",
    });
    expect(runtime.boardStarted).not.toHaveBeenCalled();
    expect(runtime.sidebarStarted).not.toHaveBeenCalled();
    const dashboard = load(pages[1]);
    loads.push(dashboard);
    await Promise.all([runtime.boardReady.promise, runtime.sidebarReady.promise]);
    await expect(dashboard).resolves.toMatchObject({
      kind: "session",
      sessionKey: "agent:roboclaw:main",
    });
    runtime.boardRelease.reject(new Error("Board chunk unavailable"));
    runtime.sidebarRelease.reject(new Error("Sidebar chunk unavailable"));
    await expect(load(pages[1])).resolves.toMatchObject({ kind: "session" });
    expect(request).not.toHaveBeenCalled();

    request.mockImplementation(async (_method, params) => params);
    const pending = context.sessions.subscribeMessages("agent:roboclaw:main");
    expect(request).not.toHaveBeenCalled();
    runtime.release.resolve();
    const subscription = await pending;
    expect(request.mock.calls.map(([method]) => method)).toEqual(["sessions.messages.subscribe"]);
    await context.sessions.unsubscribeMessages(subscription);
  } finally {
    runtime.boardRelease.resolve();
    runtime.sidebarRelease.resolve();
    runtime.release.resolve();
    await Promise.allSettled(loads);
  }
});

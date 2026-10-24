// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createSessionRouteContext } from "./route-resolution.test-support.ts";
import { pages } from "./route.ts";

const runtime = vi.hoisted(() => ({
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}));

vi.mock("../../lib/sessions/session-message-subscriptions.runtime.ts", async (importOriginal) => {
  runtime.started.resolve();
  await runtime.release.promise;
  return importOriginal();
});

it("loads subscription code during route loading without waiting or opening an observer", async () => {
  const { context, request } = createSessionRouteContext();
  const loads = pages.map(async (page) => {
    const location = { pathname: `/${page.id}/roboclaw/main`, search: "", hash: "" };
    return page.loader!(context, {
      location,
      deps: page.loaderDeps!(context, location),
      cause: "navigation",
      revalidating: false,
      shouldRun: () => true,
      signal: new AbortController().signal,
    });
  });
  try {
    await runtime.started.promise;
    expect(await Promise.all(loads)).toEqual([
      expect.objectContaining({ kind: "session", sessionKey: "agent:roboclaw:main" }),
      expect.objectContaining({ kind: "session", sessionKey: "agent:roboclaw:main" }),
    ]);
    expect(request).not.toHaveBeenCalled();

    request.mockImplementation(async (_method, params) => params);
    const pending = context.sessions.subscribeMessages("agent:roboclaw:main");
    expect(request).not.toHaveBeenCalled();
    runtime.release.resolve();
    const subscription = await pending;
    expect(request.mock.calls.map(([method]) => method)).toEqual(["sessions.messages.subscribe"]);
    await context.sessions.unsubscribeMessages(subscription);
  } finally {
    runtime.release.resolve();
    await Promise.allSettled(loads);
  }
});

// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
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

it("preloads subscriptions without waiting or opening observers", async () => {
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
    const dashboard = load(pages[1]);
    loads.push(dashboard);
    await expect(dashboard).resolves.toMatchObject({
      kind: "session",
      sessionKey: "agent:roboclaw:main",
    });
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
    runtime.release.resolve();
    await Promise.allSettled(loads);
  }
});

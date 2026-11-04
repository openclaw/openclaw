import { afterEach, expect, it, vi } from "vitest";
import { routeFixtures } from "./router-outlet-fixtures.test-support.tsx";
import {
  disposeRouterOutlets,
  mountRouterOutlet,
  settleRouterOutlet as settleOutlet,
} from "./router-outlet.test-support.tsx";

type TestContext = { label: string };
type TestData = { label: string };
const {
  page,
  router: testRouter,
  dispose: disposeRouters,
} = routeFixtures<"page", TestContext, TestData>();

afterEach(() => {
  disposeRouterOutlets();
  disposeRouters();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps reload recovery when a page's render fails on a missing interface file", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let finishProbe: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      await new Promise<Response>((resolve) => {
        finishProbe = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const context = { label: "stale" };
  const router = testRouter(
    page("page", {
      renderSolid: () => {
        throw new Error("Importing a module script failed.");
      },
    }),
  );
  const outlet = mountRouterOutlet({ router, retryContext: context });
  await router.navigate("page", context);
  await settleOutlet(outlet);

  const alert = outlet.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Check your connection, then reload");
  expect(alert?.querySelector("button")?.textContent?.trim()).toBe("Reload");
  expect(outlet.textContent).not.toContain("Importing a module script failed.");
  expect(fetchMock).toHaveBeenCalledTimes(1);

  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  finishProbe?.(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
  outlet.dispose();
  router.stop();
});

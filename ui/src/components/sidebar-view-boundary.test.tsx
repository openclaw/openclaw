/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as recovery from "../app/stale-chunk-reload.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SidebarViewBoundary } from "./sidebar-view-boundary.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function failedSidebarView(error: Error) {
  let failure: Error | undefined = error;
  const Content = () => {
    if (failure) {
      throw failure;
    }
    return <span>Sidebar recovered</span>;
  };
  const mounted = mountSolid(() => (
    <SidebarViewBoundary>
      <Content />
    </SidebarViewBoundary>
  ));
  return { ...mounted, recover: () => (failure = undefined) };
}

it("retries an ordinary sidebar failure without reloading the document", async () => {
  const reload = vi.spyOn(recovery, "retryStaleChunkReloadWhenReachable");
  const view = failedSidebarView(new Error("Temporary sidebar failure"));
  await waitForSolid(() => expect(view.getByRole("button", { name: "Retry" })).toBeDefined());
  view.recover();
  view.getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() => expect(view.container.textContent).toContain("Sidebar recovered"));
  expect(reload).not.toHaveBeenCalled();
});

it.each([false, true])(
  "reloads a stale sidebar only while its error surface remains mounted (retired: %s)",
  async (retired) => {
    const response = createDeferred<Response>();
    const probe = vi.fn<typeof fetch>(() => response.promise);
    vi.stubGlobal("fetch", probe);
    const reload = vi.fn();
    const retry = recovery.retryStaleChunkReloadWhenReachable;
    let pending: Promise<boolean> | undefined;
    vi.spyOn(recovery, "retryStaleChunkReloadWhenReachable").mockImplementation(
      (deps) =>
        (pending = retry({
          ...deps,
          storage: { getItem: () => null, setItem: () => {} },
          reload,
        })),
    );
    const view = failedSidebarView(new TypeError("Failed to fetch dynamically imported module"));
    await waitForSolid(() => expect(view.getByRole("button", { name: "Reload" })).toBeDefined());
    view.getByRole("button", { name: "Reload" }).click();
    expect(probe).toHaveBeenCalledOnce();
    if (retired) {
      view.unmount();
    }
    response.resolve(new Response(null, { status: 200 }));
    await expect(pending).resolves.toBe(!retired);
    expect(reload).toHaveBeenCalledTimes(retired ? 0 : 1);
  },
);

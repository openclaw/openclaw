import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { PluginManager } from "./control-ui-manager.solid.tsx";
import { createViewRuntime } from "./control-ui-view.test-support.ts";

function mountManager(kind: "refresh" | "reload") {
  const source = createViewRuntime();
  const gateway = createApplicationGateway();
  const refresh = vi.fn<() => Promise<void>>();
  const reload = vi.fn<() => Promise<void>>();
  Object.assign(source.context.plugins, {
    hasPlugins: true,
    canReload: true,
    errors: [],
    registrations: () => [],
    refresh,
    reload,
  });
  Object.assign(source.context, { gateway: gateway.gateway });
  const provider = createSolidApplicationContextProvider(source.context);
  const view = mountSolid(() => <PluginManager />, { wrapper: provider.wrapper });
  const findButton = () =>
    view.getByRole("button", {
      name: kind === "refresh" ? "Retry" : "Reload plugin UI",
    });
  const button = findButton();
  const expectBusy = (busy: boolean) =>
    kind === "refresh"
      ? expect(button.getAttribute("aria-busy")).toBe(String(busy))
      : expect(button.hasAttribute("disabled")).toBe(busy);
  return {
    ...view,
    gateway,
    button,
    findButton,
    expectBusy,
    request: kind === "refresh" ? refresh : reload,
  };
}

it("shows refresh failures and recovers on retry", async () => {
  const view = mountManager("refresh");
  const first = createDeferred();
  const second = createDeferred();
  view.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  view.button.click();
  await waitForSolid(() => view.expectBusy(true));
  expect(view.button.hasAttribute("disabled")).toBe(false);
  first.reject(new Error("Catalog unavailable"));
  await waitForSolid(() =>
    expect(view.getByRole("alert").textContent).toContain("Catalog unavailable"),
  );
  view.expectBusy(false);
  view.button.click();
  await waitForSolid(() => view.expectBusy(true));
  second.resolve();
  await waitForSolid(() => view.expectBusy(false));
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.findButton()).toBe(view.button);
});

it.each(["refresh", "reload"] as const)(
  "retires a pending %s when the Gateway connection changes",
  async (kind) => {
    const view = mountManager(kind);
    const oldRead = createDeferred();
    view.request.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(undefined);
    view.button.click();
    await waitForSolid(() => view.expectBusy(true));
    Object.assign(view.gateway.gateway, { connectionRevision: 1 });
    view.gateway.publish(view.gateway.gateway.snapshot);
    await waitForSolid(() => view.expectBusy(false));
    expect(view.findButton()).toBe(view.button);
    view.button.click();
    await waitForSolid(() => expect(view.request).toHaveBeenCalledTimes(2));
    await waitForSolid(() => view.expectBusy(false));
    oldRead.reject(new Error("Retired catalog read"));
    await Promise.resolve();
    await waitForSolid(() => view.expectBusy(false));
    expect(view.queryByRole("alert")).toBeNull();
  },
);

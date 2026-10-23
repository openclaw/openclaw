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

function mountManager() {
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
  return {
    ...mountSolid(() => <PluginManager />, { wrapper: provider.wrapper }),
    source,
    gateway,
    refresh,
    reload,
  };
}

it("keeps Retry available while showing pending reads and recovers after a rejection", async () => {
  const view = mountManager();
  const first = createDeferred();
  const second = createDeferred();
  view.refresh.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const retry = view.getByRole("button", { name: "Retry" });
  retry.click();
  await waitForSolid(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
  expect(retry.hasAttribute("disabled")).toBe(false);
  first.reject(new Error("Catalog unavailable"));
  await waitForSolid(() =>
    expect(view.getByRole("alert").textContent).toContain("Catalog unavailable"),
  );
  expect(retry.getAttribute("aria-busy")).toBe("false");
  retry.click();
  await waitForSolid(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
  second.resolve();
  await waitForSolid(() => expect(retry.getAttribute("aria-busy")).toBe("false"));
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByRole("button", { name: "Retry" })).toBe(retry);
});

it("retires a pending Retry presentation when the Gateway connection changes", async () => {
  const view = mountManager();
  const oldRead = createDeferred();
  view.refresh.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(undefined);
  const retry = view.getByRole("button", { name: "Retry" });
  retry.click();
  await waitForSolid(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
  Object.assign(view.gateway.gateway, { connectionRevision: 1 });
  view.gateway.publish(view.gateway.gateway.snapshot);
  await waitForSolid(() => expect(retry.getAttribute("aria-busy")).toBe("false"));
  retry.click();
  await waitForSolid(() => expect(retry.getAttribute("aria-busy")).toBe("false"));
  oldRead.reject(new Error("Retired catalog read"));
  await Promise.resolve();
  expect(view.queryByRole("alert")).toBeNull();
});

it("preserves Reload action failure presentation", async () => {
  const view = mountManager();
  const request = createDeferred();
  view.reload.mockReturnValueOnce(request.promise);
  const reload = view.getByRole("button", { name: "Reload plugin UI" });
  reload.click();
  await waitForSolid(() => expect(reload.hasAttribute("disabled")).toBe(true));
  request.reject(new Error("Reload unavailable"));
  await waitForSolid(() =>
    expect(view.getByRole("alert").textContent).toContain("Reload unavailable"),
  );
  expect(reload.hasAttribute("disabled")).toBe(false);
});

it("retires a pending Reload when the Gateway connection changes", async () => {
  const view = mountManager();
  const oldReload = createDeferred();
  view.reload.mockReturnValueOnce(oldReload.promise).mockResolvedValueOnce(undefined);
  const reload = view.getByRole("button", { name: "Reload plugin UI" });
  reload.click();
  await waitForSolid(() => expect(reload.hasAttribute("disabled")).toBe(true));
  Object.assign(view.gateway.gateway, { connectionRevision: 1 });
  view.gateway.publish(view.gateway.gateway.snapshot);
  await waitForSolid(() => expect(reload.hasAttribute("disabled")).toBe(false));
  expect(view.getByRole("button", { name: "Reload plugin UI" })).toBe(reload);
  reload.click();
  await waitForSolid(() => expect(view.reload).toHaveBeenCalledTimes(2));
  oldReload.reject(new Error("Retired plugin reload"));
  await waitForSolid(() => expect(reload.hasAttribute("disabled")).toBe(false));
  expect(view.queryByRole("alert")).toBeNull();
});

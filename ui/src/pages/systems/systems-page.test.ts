/* @vitest-environment jsdom */
import type {
  EnvironmentSummary,
  SessionPlacement,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
import { createRouter, definePage } from "@openclaw/uirouter";
import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { DesktopClient } from "../../components/desktop/desktop-client.ts";
import { createConnectionHandle } from "../../components/desktop/desktop-panel.test-support.ts";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import type { SparklineSample } from "../../components/sparkline-tile.tsx";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { setupSidebarTest } from "../../test-helpers/app-sidebar-setup.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
} from "../../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid as cleanup, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderSidebar, renderSolid } from "./systems-route-view.tsx";
import { createSystems, type Systems, type SystemsRouteData } from "./systems-state.ts";
import "./systems-sidebar.tsx";
import { systemInfo as baseSystemInfo } from "./systems.test-support.ts";

setupSidebarTest();
const runtimeConfigs: ReturnType<typeof createRuntimeConfigCapability>[] = [];
afterEach(() => {
  cleanup();
  for (const config of runtimeConfigs.splice(0)) {
    config.dispose();
  }
  vi.restoreAllMocks();
});

function environment(
  id: string,
  type: EnvironmentSummary["type"],
  label: string,
  fields: Partial<EnvironmentSummary> = {},
): EnvironmentSummary {
  return { id, type, label, status: "available", ...fields };
}
const host = environment("gateway", "local", "Gateway");
const worker = environment("worker-one", "worker", "Cloud worker", { desktop: true });
const offline = environment("node:offline", "node", "Offline laptop", { status: "unavailable" });
const desktopSetupHost: EnvironmentSummary = { ...host, desktopSetup: { state: "ready" } };
const systemInfo: SystemInfoResult = {
  ...baseSystemInfo,
  loadAverage: [0.5, 0.4, 0.3],
};

function harness(
  inventory: () => Promise<EnvironmentSummary[]> = async () => [host, worker, offline],
  nodes: () => NodeListNode[] = () => [{ nodeId: "offline", connected: false, paired: true }],
) {
  const handlers: Record<string, () => unknown> = {
    "environments.list": async () => ({ environments: await inventory() }),
    "system.info": () => systemInfo,
    "node.list": () => ({ nodes: nodes() }),
    "desktop.observe": () => ({
      transport: "rfb",
      wsPath: "/desktop/proof",
      expiresAtMs: Date.now() + 60000,
      control: false,
    }),
  };
  const request = vi.fn(
    async (method: string, _params?: unknown, _options?: { signal?: AbortSignal }) => {
      if (!Object.hasOwn(handlers, method)) {
        throw new Error("Unexpected request: " + method);
      }
      return handlers[method]!();
    },
  );
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: gatewayHelloForMethods(
      [
        "environments.list",
        "node.list",
        "system.info",
        "desktop.observe",
        "config.get",
        "config.patch",
      ],
      ["operator.admin"],
    ),
  });
  const context = createContext(gateway.gateway, createSessions("main", []));
  const runtimeConfig = createRuntimeConfigCapability(gateway.gateway);
  runtimeConfigs.push(runtimeConfig);
  Object.assign(context, {
    basePath: "",
    navigate: vi.fn(),
    runtimeConfig,
    router: createRouter({
      routes: [
        definePage({ id: "systems", path: "/systems", component: () => ({}) }),
        definePage({ id: "debug", path: "/debug", component: () => ({}) }),
      ],
    }),
  });
  const controller = createSystems(context);
  return { controller, gateway, context, request };
}

function text(root: ParentNode, selector: string) {
  return root.querySelector(selector)?.textContent;
}
function waitForContent(root: ParentNode, selector: string, expected: string) {
  return waitForSolid(() => expect(text(root, selector)).toContain(expected));
}
function desktopConfig(enabled: boolean) {
  return { config: { desktop: { host: { enabled } } }, hash: String(enabled), valid: true };
}
function points(root: ParentNode) {
  return root.querySelector(".sparkline-tile__chart polyline")?.getAttribute("points")?.split(" ");
}
function calls(request: ReturnType<typeof harness>["request"], method: string) {
  return request.mock.calls.filter(([name]) => name === method);
}
function openDesktop(environmentId: string) {
  window.dispatchEvent(
    new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail: { open: true, environmentId } }),
  );
}
function routeView(
  data: () => SystemsRouteData | undefined,
  presented = () => true,
  pending = () => false,
) {
  return createComponent(renderSolid, {
    get data() {
      return data();
    },
    get presented() {
      return presented();
    },
    get loaderPending() {
      return pending();
    },
  });
}

async function mount(controller: Systems, presented = () => true) {
  const sidebar = renderSidebar({ controller })!;
  const data = { controller };
  const mounted = mountSolid(() => [routeView(() => data, presented), sidebar]);
  await waitForSolid(() => expect(controller.state.inventory).not.toBeNull());
  await sidebar.updateComplete;
  const page = mounted.container.querySelector<HTMLElement>("openclaw-systems-page")!;
  return { page, sidebar, unmount: mounted.unmount };
}

describe("Systems workspace", () => {
  it.each(["system.info", "node.list"])(
    "shows the device inventory while %s is pending",
    async (method) => {
      const telemetry = createDeferred<unknown>();
      const { controller, request } = harness();
      const respond = request.getMockImplementation()!;
      request.mockImplementation((called, params, options) => {
        if (called === method) {
          return telemetry.promise;
        }
        return respond(called, params, options);
      });
      const { page, sidebar } = await mount(controller);
      expect(sidebar.textContent).toContain("Cloud worker");
      const selectedId = method === "system.info" ? host.id : offline.id;
      controller.select(selectedId);
      await waitForSolid(() => expect(text(page, ".systems-no-telemetry")).toBe("Loading…"));
      controller.select(worker.id);
      controller.updatePresentation({ showDetails: true });
      await waitForSolid(() => expect(text(page, ".systems-heading h2")).toBe("Cloud worker"));
      expect(page.querySelector(".systems-details")).not.toBeNull();
      const healthyMethod = method === "system.info" ? "node.list" : "system.info";
      controller.select(healthyMethod === "system.info" ? host.id : offline.id);
      const reads = calls(request, healthyMethod).length;
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15_000);
      await controller.refreshTelemetry();
      expect(calls(request, healthyMethod)).toHaveLength(reads + 1);
      controller.select(selectedId);
      telemetry.reject(new Error("Telemetry unavailable"));
      await waitForSolid(() =>
        expect(text(page, ".systems-no-telemetry")).toBe("Telemetry unavailable"),
      );
      request.mockImplementation(respond);
      await controller.refreshTelemetry();
      await waitForSolid(() =>
        expect(text(page, ".systems-no-telemetry")).not.toBe("Telemetry unavailable"),
      );
    },
  );

  const cloudWorker: NonNullable<EnvironmentSummary["worker"]> = {
    providerId: "crabbox",
    profileId: "standard",
    state: "ready",
    ageMs: 0,
    attachedSessionIds: [],
    tunnelStatus: "stopped",
  };
  it.each([
    [worker, "Device"],
    [{ ...worker, worker: { ...cloudWorker, providerId: "device" } }, "Device"],
    [{ ...worker, worker: cloudWorker }, "Cloud device · standard"],
  ] satisfies [EnvironmentSummary, string][])(
    "labels device placement from provisioned metadata %#",
    async (device, label) => {
      const { controller } = harness(async () => [device]);
      controller.select(device.id);
      const { page } = await mount(controller);
      expect(text(page, ".systems-heading span")).toBe(label);
    },
  );

  it.each([
    [[], "You need admin access to view a desktop."],
    [["operator.admin"], "Desktop access isn’t available on this device."],
  ])("distinguishes desktop permissions from unavailable service %#", async (scopes, hint) => {
    const { controller, gateway } = harness(async () => [{ ...host, desktop: true }]);
    controller.select(host.id);
    const { page } = await mount(controller);
    gateway.publish({
      hello: gatewayHelloForMethods(["environments.list", "node.list", "system.info"], scopes),
    });
    await waitForContent(page, ".systems-state", hint);
  });
  it("retains inventory while a failed refresh is retried through its visible error", async () => {
    let read: () => Promise<EnvironmentSummary[]> = async () => [host, worker];
    const { controller } = harness(() => read());
    const { page, sidebar } = await mount(controller);
    const original = controller.state.inventory;
    const pending = createDeferred<EnvironmentSummary[]>();
    read = () => pending.promise;
    const refresh = controller.refresh("manual");
    await waitForSolid(() =>
      expect(sidebar.querySelector<HTMLButtonElement>(".systems-filter__refresh")?.disabled).toBe(
        true,
      ),
    );
    expect(controller.state.inventory).toBe(original);
    pending.reject(new Error("Inventory unavailable"));
    await refresh;
    await waitForContent(page, '[role="alert"]', "Inventory unavailable");
    expect(controller.state.inventory).toBe(original);
    expect(sidebar.querySelectorAll(".systems-machine")).toHaveLength(2);
    read = async () => [host, worker, offline];
    page.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await waitForSolid(() => expect(sidebar.querySelectorAll(".systems-machine")).toHaveLength(3));
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(controller.state.selectedId).toBe(host.id);
  });

  it("defers hidden initial and event reads, preserving inventory until visible recovery", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const gatewayHost = { ...host, desktop: false };
    let environments = [gatewayHost, worker, offline];
    const { controller, gateway, request } = harness(async () => environments);
    const data = { controller };
    mountSolid(() => routeView(() => data));
    flush();
    await vi.advanceTimersByTimeAsync(0);
    const statusReads = () => calls(request, "system.info");
    expect(statusReads()).toHaveLength(0);
    expect(controller.state.inventory).toBeNull();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(statusReads()).toHaveLength(1);
    const inventory = controller.state.inventory;
    expect(inventory?.gatewaySystemInfo?.machineName).toBe(systemInfo.machineName);
    controller.updatePresentation({ showStats: !controller.statsVisible() });
    expect(controller.statsVisible() || controller.state.showDetails).toBe(false);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    environments = [gatewayHost, { ...worker, id: "worker-after-hidden", desktop: false }];
    gateway.publishEvent("presence", {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statusReads()).toHaveLength(1);
    expect(controller.state.inventory).toBe(inventory);
    expect(calls(request, "environments.list")).toHaveLength(1);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(statusReads()).toHaveLength(2);
    expect(controller.state.rows.map((row) => row.environment)).toMatchObject([
      { id: "gateway" },
      { id: "worker-after-hidden", desktop: false },
    ]);
    expect(controller.needsInventoryRefresh()).toBe(false);
  });

  it("keeps desktop setup active through route refreshes and renders rejected writes", async () => {
    const pending = createDeferred<boolean>();
    const { controller, context } = harness(async () => [desktopSetupHost]);
    vi.spyOn(context.runtimeConfig, "ensureLoaded").mockResolvedValue();
    const patch = vi.spyOn(context.runtimeConfig, "patch").mockReturnValue(pending.promise);
    const [route, setRoute] = createSignal({
      data: { controller },
      loaderPending: false,
      presented: true,
    });
    const mounted = mountSolid(() =>
      routeView(
        () => route().data,
        () => route().presented,
        () => route().loaderPending,
      ),
    );
    await waitForSolid(() => expect(controller.state.inventory).not.toBeNull());
    const enable = mounted.container.querySelector<HTMLButtonElement>(".systems-state button")!;
    enable.click();
    await waitForSolid(() => expect(patch).toHaveBeenCalledOnce());
    setRoute({ data: { controller }, loaderPending: true, presented: true });
    flush();
    expect(mounted.container.querySelector(".systems-state button")).toBe(enable);
    expect(enable.disabled).toBe(true);
    expect(enable.textContent).toContain("Enabling");
    pending.reject(new Error("Desktop configuration could not be saved"));
    await waitForContent(
      mounted.container,
      '[role="alert"]',
      "Desktop configuration could not be saved",
    );
    expect(enable.disabled).toBe(false);
  });

  it("updates desktop setup when only the configuration owner publishes", async () => {
    const { controller, context } = harness(async () => [desktopSetupHost]);
    const { page } = await mount(controller);
    expect(text(page, ".systems-state button")).toContain("Enable desktop access in OpenClaw");
    const request = vi.spyOn(context.gateway.snapshot.client!, "request");
    for (const enabled of [true, false]) {
      request.mockResolvedValueOnce(desktopConfig(enabled));
      await context.runtimeConfig.refresh();
      if (enabled) {
        await waitForSolid(() =>
          expect(text(page, ".systems-state h2")).toBe("Desktop access is enabled"),
        );
        expect(page.querySelector(".systems-state button")).toBeNull();
      } else {
        await waitForContent(page, ".systems-state button", "Enable desktop access in OpenClaw");
      }
    }
  });

  it.each(["selection", "authority", "route"])(
    "cancels pending desktop enablement when %s changes",
    async (change) => {
      const loaded = createDeferred();
      const { controller, context, gateway } = harness(async () => [
        desktopSetupHost,
        { ...worker, desktop: false },
      ]);
      vi.spyOn(context.runtimeConfig, "ensureLoaded").mockReturnValue(loaded.promise);
      const patch = vi.spyOn(context.runtimeConfig, "patch");
      const [presented, setPresented] = createSignal(true);
      const { page } = await mount(controller, presented);
      page.querySelector<HTMLButtonElement>(".systems-state button")!.click();
      await waitForSolid(() => expect(controller.desktopSetupBusy()).toBe(true));
      if (change === "selection") {
        controller.select(worker.id);
      } else if (change === "authority") {
        gateway.publish({
          hello: gatewayHelloForMethods(
            ["environments.list", "node.list", "system.info", "config.get", "config.patch"],
            ["operator.read"],
          ),
        });
      } else {
        const navigation = context.router.navigate("debug", context);
        setPresented(false);
        await navigation;
        await waitForSolid(() => expect(controller.desktopSetupBusy()).toBe(false));
      }
      loaded.resolve();
      await loaded.promise;
      await waitForSolid(() => expect(controller.desktopSetupBusy()).toBe(false));
      expect(patch).not.toHaveBeenCalled();
      if (change === "route") {
        setPresented(true);
        await waitForContent(page, ".systems-state button", "Enable desktop access in OpenClaw");
      }
    },
  );

  it("sorts and filters the machine inventory without replacing the selected machine", async () => {
    const warnings = vi.spyOn(console, "warn");
    // Open menus need frame boundaries instead of the sidebar fixture's recursive microtasks.
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const environments: EnvironmentSummary[] = [
      host,
      { ...offline, id: "node:delta", label: "Delta laptop" },
      // Auxiliary node data says disconnected; the environment inventory owns availability.
      { ...offline, label: "Zulu laptop", status: "available" },
      { ...offline, id: "node:alpha", label: "Álpha" },
      { ...offline, id: "node:beta", label: "Be\u0301ta", status: "available" },
      ...(
        [
          [worker.id, worker.label, "available"],
          ["worker-starting", "Preparing worker", "starting"],
          ["worker-offline", "Retained worker", "unavailable"],
        ] as const
      ).map(([id, label, status]) =>
        Object.assign({}, worker, { id, label, status, desktop: false }),
      ),
    ];
    const { controller, request } = harness(async () => environments);
    const initial = await mount(controller);
    const { page } = initial;
    let { sidebar } = initial;
    const names = (selector = ".systems-machine__name") =>
      [...sidebar.querySelectorAll(selector)].map((entry) => entry.textContent?.trim());
    const nodeNames = () => names(".systems-group:first-of-type .systems-machine__name");
    const counts = () => names(".systems-group__count");
    const choose = async (value: string) => {
      const menu = sidebar.querySelector(".systems-filter-menu");
      const trigger = menu?.querySelector<HTMLButtonElement>(".oc-menu-trigger");
      trigger!.click();
      await waitForSolid(() => expect(trigger!.getAttribute("aria-expanded")).toBe("true"));
      vi.advanceTimersToNextFrame();
      const item = menu?.querySelector<HTMLButtonElement>(`.oc-menu-item[data-value="${value}"]`);
      item!.click();
      vi.advanceTimersToNextFrame();
      await sidebar.updateComplete;
      flush();
      expect(menu?.querySelector(`[data-value="${value}"]`)?.getAttribute("aria-checked")).toBe(
        "true",
      );
    };
    const search = async (value: string) => {
      const input = sidebar.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sidebar.updateComplete;
    };

    expect(nodeNames()).toEqual(["Be\u0301ta", "Zulu laptop", "Álpha", "Delta laptop"]);
    expect(counts()).toEqual(["4", "3"]);
    const selected = [...sidebar.querySelectorAll<HTMLButtonElement>(".systems-machine")].find(
      (button) => button.querySelector(".systems-machine__name")?.textContent === "Zulu laptop",
    );
    selected!.click();
    flush();

    await choose("sort:name");
    expect(nodeNames()).toEqual(["Álpha", "Be\u0301ta", "Delta laptop", "Zulu laptop"]);
    await choose("sort:offline-first");
    expect(nodeNames()).toEqual(["Álpha", "Delta laptop", "Be\u0301ta", "Zulu laptop"]);
    await choose("status:offline");
    expect(names()).toEqual(["Álpha", "Delta laptop", "Retained worker"]);
    expect(counts()).toEqual(["2", "1"]);
    expect(text(page, ".systems-heading h2")).toBe("Zulu laptop");
    expect(page.querySelector<HTMLSelectElement>(".systems-mobile-picker")?.value).toBe(offline.id);

    await choose("status:online");
    expect(names()).toEqual(["Test Gateway", "Be\u0301ta", "Zulu laptop", "Cloud worker"]);
    await search("  A\u0301LPHA  ");
    expect(names()).toEqual([]);
    expect(text(sidebar, ".systems-sidebar__empty")).toBe("No devices match your search.");
    await choose("status:all");
    expect(names()).toEqual(["Álpha"]);
    await choose("status:offline");
    expect(names()).toEqual(["Álpha"]);
    expect(controller.state.selectedId).toBe(offline.id);
    expect(calls(request, "environments.list")).toHaveLength(1);

    initial.unmount();
    ({ sidebar } = await mount(controller));
    await waitForSolid(() => expect(controller.loading()).toBe(false));
    await sidebar.updateComplete;
    expect(names()).toEqual(["Álpha"]);
    await search("BÉTA");
    expect(names()).toEqual([]);
    await choose("status:all");
    expect(nodeNames()).toEqual(["Be\u0301ta"]);
    expect(controller.state.inventory?.environments).toEqual(environments);
    expect(
      warnings.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("[NO_OWNER_EFFECT]")),
    ).toEqual([]);
  });

  it.each([1, 4, 12])(
    "summarizes %i disks without losing the full list in Details",
    async (count) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const { controller, request } = harness();
      const { page } = await mount(controller);
      clock.mockReturnValue(Date.now() + 15_000);
      const disks = Array.from({ length: count }, (_, index) => ({
        path: `/volume-${index}`,
        totalBytes: 1024 ** 4,
        availableBytes: (count - index) * 1024 ** 3,
      }));
      request.mockResolvedValueOnce({ ...systemInfo, disks });
      await controller.refreshTelemetry();
      await waitForSolid(() =>
        expect(text(page, ".systems-volume-summary")).toContain(`/volume-${count - 1}`),
      );
      expect(page.querySelectorAll(".systems-volume-summary li")).toHaveLength(3);
      expect(
        [...page.querySelectorAll(".systems-volume-summary li span:first-child")].map(
          (element) => element.textContent,
        ),
      ).toEqual(
        disks
          .toReversed()
          .slice(0, 3)
          .map((disk) => disk.path),
      );
      const more = page.querySelector<HTMLButtonElement>(".systems-volume-summary button")!;
      expect(more.textContent).toBe(
        count > 3 ? `+${count - 3} more volumes in Details` : "All volumes in Details",
      );
      more.focus();
      more.click();
      await waitForSolid(() =>
        expect(page.querySelectorAll(".systems-details .systems-vital--disk")).toHaveLength(count),
      );
      expect(document.activeElement).toBe(page.querySelector(".systems-details"));
      page.querySelector<HTMLButtonElement>('[aria-label="Close details"]')!.click();
      await waitForSolid(() => expect(page.querySelector(".systems-details")).toBeNull());
      expect(document.activeElement).toBe(more);
    },
  );

  it("keeps disk histories attached to mount paths through reordering, removal, and return", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const { controller, request } = harness();
    const { page } = await mount(controller);
    controller.updatePresentation({ showStats: false, showDetails: true });
    flush();
    const root = { path: "/", totalBytes: 1024 ** 4, availableBytes: 100 * 1024 ** 3 };
    const archive = {
      path: "/Volumes/Archive",
      totalBytes: 2 * 1024 ** 4,
      availableBytes: 800 * 1024 ** 3,
    };
    const publish = async (disks: NonNullable<SystemInfoResult["disks"]>) => {
      clock.mockReturnValue(Date.now() + 15_000);
      request.mockResolvedValueOnce({
        ...systemInfo,
        diskTotalBytes: root.totalBytes,
        diskAvailableBytes: root.availableBytes,
        disks,
      });
      await controller.refreshTelemetry();
      flush();
    };
    type DiskTile = HTMLElement & { samples: readonly SparklineSample[] };
    const disk = (path: string) =>
      page.querySelector<DiskTile>(`.systems-vital--disk[title="${path}"]`);
    await publish([root, archive]);
    await waitForSolid(() => expect(disk(archive.path)?.textContent).toContain("800 GB"));
    expect(page.querySelectorAll(".systems-vital--disk")).toHaveLength(2);
    const rootTile = disk(root.path);
    const archiveTile = disk(archive.path);
    expect(rootTile?.querySelector(".sparkline-tile__chart")).toBeNull();

    await publish([
      { ...archive, availableBytes: 750 * 1024 ** 3 },
      { ...root, availableBytes: 90 * 1024 ** 3 },
    ]);
    await waitForSolid(() => expect(disk(archive.path)?.textContent).toContain("750 GB"));
    expect(disk(root.path)).toBe(rootTile);
    expect(disk(archive.path)).toBe(archiveTile);
    expect(rootTile?.samples.map((sample) => sample.value / 1024 ** 3)).toEqual([100, 90]);
    expect(archiveTile?.samples.map((sample) => sample.value / 1024 ** 3)).toEqual([800, 750]);

    await publish([root]);
    expect(disk(archive.path)).toBeNull();
    await publish([root, archive]);
    await waitForSolid(() => expect(disk(archive.path)?.textContent).toContain("800 GB"));
    expect(disk(archive.path)?.samples).toHaveLength(1);
    expect(disk(archive.path)?.querySelector(".sparkline-tile__chart")).toBeNull();
    await publish([]);
    expect(page.querySelectorAll(".systems-vital--disk")).toHaveLength(0);
  });

  it("adds fresh Gateway readings and marks a failed poll as last-known without adding a point", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { controller, request } = harness();
    const { page } = await mount(controller);
    clock.mockReturnValue(now + 15_000);
    request.mockResolvedValueOnce({ ...systemInfo, loadAverage: [2, 1, 0.5] });
    await controller.refreshTelemetry();
    await waitForSolid(() => expect(text(page, ".sparkline-tile__value")?.trim()).toBe("2.00"));
    expect(points(page)).toHaveLength(2);
    expect(page.querySelector('.systems-metrics[data-stale="false"]')).not.toBeNull();
    clock.mockReturnValue(now + 30_000);
    request.mockRejectedValueOnce(new Error("Telemetry unavailable"));
    await controller.refreshTelemetry();
    flush();
    expect(points(page)).toHaveLength(2);
    expect(page.querySelector('.systems-metrics[data-stale="true"]')).not.toBeNull();
    expect(text(page, ".systems-sample-time")).toContain("Last reported");
  });

  it("graphs genuine node reports, preserves per-machine history, and leaves gaps for missing metrics", async () => {
    let node: EnvironmentSummary = { ...offline, status: "available" };
    let stats: NonNullable<NodeListNode["hostStats"]> = {
      cpuCount: 8,
      loadAverage: [2, 1, 1],
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryFreeBytes: 8 * 1024 ** 3,
      diskTotalBytes: 1024 ** 4,
      diskAvailableBytes: 256 * 1024 ** 3,
      updatedAtMs: Date.now() - 60_000,
    };
    const { controller, gateway, request } = harness(
      async () => [host, node],
      () => [{ nodeId: "offline", connected: true, paired: true, hostStats: stats }],
    );
    const connect = vi.spyOn(DesktopClient.prototype, "connect");
    const { page } = await mount(controller);
    const initialCalls = request.mock.calls.length;
    gateway.publishEvent("node.hostStats", { nodeId: "unrelated-node" });
    expect(request.mock.calls).toHaveLength(initialCalls);
    controller.select(node.id);
    controller.updatePresentation({ showStats: false, showDetails: true });
    const readings = () =>
      [...page.querySelectorAll(".sparkline-tile__value")].map((tile) => tile.textContent?.trim());
    await waitForSolid(() => expect(readings()).toEqual(["2.00", "8.0 GB", "256 GB"]));
    expect(page.querySelector('.systems-metrics[data-stale="false"]')).not.toBeNull();
    expect(page.querySelectorAll(".sparkline-tile__chart")).toHaveLength(0);

    stats = { ...stats, loadAverage: [4, 2, 1], updatedAtMs: stats.updatedAtMs + 60_000 };
    await controller.refreshTelemetry();
    await waitForSolid(() => expect(readings()[0]).toBe("4.00"));
    expect(points(page)).toHaveLength(2);
    await controller.refreshTelemetry();
    flush();
    expect(points(page)).toHaveLength(2);
    controller.select(host.id);
    await waitForSolid(() => expect(readings()[0]).toBe("0.50"));
    controller.select(node.id);
    await waitForSolid(() => expect(readings()[0]).toBe("4.00"));
    expect(points(page)).toHaveLength(2);

    stats = {
      ...stats,
      loadAverage: undefined,
      diskAvailableBytes: undefined,
      diskTotalBytes: undefined,
      updatedAtMs: stats.updatedAtMs + 60_000,
    };
    await controller.refreshTelemetry();
    await waitForSolid(() => expect(readings()).toEqual(["–", "8.0 GB", "–"]));
    expect(page.querySelectorAll(".sparkline-tile__chart")).toHaveLength(1);
    stats = { ...stats, loadAverage: [3, 2, 1], updatedAtMs: stats.updatedAtMs + 60_000 };
    await controller.refreshTelemetry();
    await waitForSolid(() => expect(readings()[0]).toBe("3.00"));
    expect(
      page.querySelector("openclaw-sparkline")?.querySelector(".sparkline-tile__chart"),
    ).toBeNull();

    node = { ...node, status: "unavailable" };
    await controller.refresh();
    flush();
    expect(page.textContent).toContain("This device is offline");
    expect(page.textContent).toContain("Last reported");
    expect(page.querySelector('.systems-metrics[data-stale="true"]')).not.toBeNull();
    expect(connect).not.toHaveBeenCalled();

    gateway.publish({ phase: "offline" });
    await waitForSolid(() =>
      expect(page.querySelectorAll(".sparkline-tile__chart")).toHaveLength(0),
    );
    expect(readings()[0]).toBe("3.00");
    expect(page.querySelector('.systems-metrics[data-stale="true"]')).not.toBeNull();
  });

  it("re-reads worker lifecycle when a session placement changes", async () => {
    const cloud = (state: "attached" | "destroying" | "destroyed") =>
      environment("worker:cloud", "worker", "Cloud worker", {
        worker: {
          providerId: "crabbox",
          state,
          ageMs: 1,
          attachedSessionIds: [],
          tunnelStatus: "stopped",
        },
      });
    let environments = [host, cloud("attached")];
    const { controller, gateway, request } = harness(async () => environments);
    const { sidebar, unmount } = await mount(controller);
    expect(sidebar.textContent).toContain("Cloud worker");
    const reads = () => calls(request, "environments.list").length;
    const initialReads = reads();
    // The session need not be in the loaded session list; events alone carry placement.
    const place = (placement: SessionPlacement | null, reason = "placement") =>
      gateway.publishEvent("sessions.changed", {
        sessionKey: "agent:main:cloud",
        reason,
        placement,
      });

    place(null, "activity-summary");
    gateway.publishEvent("sessions.changed", { sessionKey: "agent:main:cloud", reason: "send" });
    expect(reads()).toBe(initialReads);

    const active = createActiveSessionPlacement({ environmentId: "worker:cloud" });
    place(active, "dispatch");
    await waitForSolid(() => expect(reads()).toBe(initialReads + 1));
    place({ ...active, updatedAtMs: 2 }, "activity-summary");
    await waitForSolid(() => expect(controller.loading()).toBe(false));
    expect(reads()).toBe(initialReads + 1);

    environments = [host, { ...cloud("destroying"), status: "stopping" }];
    const { generation, createdAtMs, environmentId } = active;
    const reclaimed = {
      generation,
      createdAtMs,
      environmentId,
      updatedAtMs: 3,
      stateChangedAtMs: 3,
    };
    place({ ...reclaimed, state: "reclaimed" }, "reclaim");
    await waitForSolid(() => expect(sidebar.textContent).toContain("Stopping"));
    expect(reads()).toBe(initialReads + 2);
    // Teardown completes without another session event; the page tick re-reads it.
    expect(controller.needsInventoryRefresh()).toBe(true);
    environments = [host, cloud("destroyed")];
    await controller.refresh();
    await waitForSolid(() => expect(sidebar.textContent).not.toContain("Cloud worker"));
    expect(controller.needsInventoryRefresh()).toBe(false);
    unmount();
  });

  it("shares inventory, keeps a single view-only connection through presentation changes, and retains a removed selection", async () => {
    let environments = [host, worker, offline];
    const { controller, request } = harness(async () => environments);
    const handle = createConnectionHandle();
    const connect = vi
      .spyOn(DesktopClient.prototype, "connect")
      .mockImplementation(async (options) => {
        options.onConnect?.();
        return handle;
      });
    const { page, sidebar, unmount } = await mount(controller);
    expect(sidebar.querySelectorAll(".systems-machine")).toHaveLength(3);
    expect(page.textContent).toContain("No desktop available");
    expect(calls(request, "environments.list")).toHaveLength(1);
    const entry = [...sidebar.querySelectorAll<HTMLButtonElement>(".systems-machine")].find(
      (button) => button.textContent?.includes("Cloud worker"),
    );
    entry!.click();
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: worker.id },
      control: false,
    });
    const viewer = page.querySelector("openclaw-desktop-panel");
    expect(viewer?.embedded).toBe(true);
    controller.updatePresentation({ showStats: !controller.statsVisible() });
    controller.updatePresentation({ showDetails: !controller.state.showDetails });
    await controller.refresh();
    flush();
    expect(page.querySelector("openclaw-desktop-panel")).toBe(viewer);
    expect(connect).toHaveBeenCalledOnce();
    expect(page.querySelector<HTMLSelectElement>(".systems-mobile-picker")?.value).toBe(worker.id);
    environments = [host, offline];
    await controller.refresh();
    flush();
    expect(controller.state.selectedId).toBe(worker.id);
    expect(page.textContent).toContain("This device is no longer listed");
    expect(page.querySelector<HTMLSelectElement>(".systems-mobile-picker")?.value).toBe("");
    expect(page.querySelector("openclaw-desktop-panel")).toBeNull();
    await waitForSolid(() => expect(handle.disconnect).toHaveBeenCalled());
    openDesktop("worker-no-longer-known");
    flush();
    expect(controller.state.selectedId).toBe("worker-no-longer-known");
    expect(page.textContent).toContain("This device is no longer listed");
    expect(connect).toHaveBeenCalledOnce();
    unmount();
  });

  it("drops late work after departure or gateway replacement", async () => {
    const delayed = createDeferred<EnvironmentSummary[]>();
    const { controller, gateway, request } = harness(() => delayed.promise);
    const [data, setData] = createSignal<SystemsRouteData>();
    const [presented, setPresented] = createSignal(true);
    const mounted = mountSolid(() => routeView(data, presented));
    flush();
    expect(mounted.container.querySelector("openclaw-systems-page")).toBeNull();
    setData({ controller });
    flush();
    const page = mounted.container.querySelector("openclaw-systems-page");
    expect(page).not.toBeNull();
    setPresented(false);
    flush();
    const initialRead = request.mock.calls.find(([method]) => method === "environments.list");
    expect(initialRead?.[2]?.signal?.aborted).toBe(true);
    delayed.resolve([host, { ...worker, desktop: false }]);
    await delayed.promise;
    flush();
    expect(controller.state.inventory).toBeNull();
    setPresented(true);
    await waitForSolid(() => expect(controller.state.inventory).not.toBeNull());
    // Simulate a new revision from the Gateway owner; consumers only read this property.
    Object.defineProperty(gateway.gateway, "connectionRevision", { value: 1 });
    gateway.publish({});
    expect(controller.state.rows).toEqual([]);
    expect(controller.selected()).toBeUndefined();
    const replacement = harness(async () => [host]);
    setData({ controller: replacement.controller });
    await waitForSolid(() => expect(replacement.controller.state.inventory).not.toBeNull());
    expect(mounted.container.querySelector("openclaw-systems-page")).toBe(page);
    mounted.unmount();
    const initialCalls = replacement.request.mock.calls.length;
    openDesktop(worker.id);
    replacement.gateway.publishEvent("presence", {});
    expect(replacement.request.mock.calls).toHaveLength(initialCalls);
    expect(replacement.controller.state.selectedId).toBe(host.id);
  });
});

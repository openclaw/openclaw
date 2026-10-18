/* @vitest-environment jsdom */
import type {
  BackupStatusResult,
  EnvironmentSummary,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
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
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderSidebar, renderSolid } from "./systems-route-view.tsx";
import { createSystems, type Systems, type SystemsRouteData } from "./systems-state.ts";
import "./systems-sidebar.tsx";

setupSidebarTest();
const runtimeConfigs: ReturnType<typeof createRuntimeConfigCapability>[] = [];
afterEach(() => {
  cleanup();
  for (const config of runtimeConfigs.splice(0)) {
    config.dispose();
  }
  vi.restoreAllMocks();
});

const host: EnvironmentSummary = {
  id: "gateway",
  type: "local",
  label: "Gateway",
  status: "available",
};
const worker: EnvironmentSummary = {
  id: "worker-one",
  type: "worker",
  label: "Cloud worker",
  status: "available",
  desktop: true,
};
const offline: EnvironmentSummary = {
  id: "node:offline",
  type: "node",
  label: "Offline laptop",
  status: "unavailable",
};
const systemInfo: SystemInfoResult = {
  machineName: "Test Gateway",
  hostname: "gateway.test",
  platform: "linux",
  release: "test",
  arch: "x64",
  osLabel: "Linux",
  nodeVersion: "v26",
  pid: 1,
  uptimeMs: 1000,
  cpuCount: 4,
  loadAverage: [0.5, 0.4, 0.3],
  memoryTotalBytes: 8192,
  memoryFreeBytes: 4096,
};

function harness(
  inventory: () => Promise<EnvironmentSummary[]> = async () => [host, worker, offline],
  nodes: () => NodeListNode[] = () => [
    {
      nodeId: "offline",
      connected: false,
      paired: true,
      hostStats: {
        cpuCount: 2,
        memoryTotalBytes: 4096,
        memoryFreeBytes: 2048,
        updatedAtMs: Date.now(),
      },
    },
  ],
  backups: () => Promise<BackupStatusResult> = async () => ({
    targets: [],
    schedules: [],
    locations: [],
  }),
) {
  const request = vi.fn(
    async (method: string, _params?: unknown, _options?: { signal?: AbortSignal }) => {
      if (method === "environments.list") {
        return { environments: await inventory() };
      }
      if (method === "system.info") {
        return systemInfo;
      }
      if (method === "node.list") {
        return { nodes: nodes() };
      }
      if (method === "backup.status") {
        return backups();
      }
      if (method === "storage.locations.probe") {
        return { state: "ok", freeBytes: 1024 ** 3 };
      }
      if (method === "desktop.observe") {
        return {
          transport: "rfb",
          wsPath: "/desktop/proof",
          expiresAtMs: Date.now() + 60000,
          control: false,
        };
      }
      throw new Error("Unexpected request: " + method);
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
  Object.assign(context, { basePath: "", navigate: vi.fn(), runtimeConfig });
  const controller = createSystems(context);
  return { controller, gateway, context, request };
}

async function mount(controller: Systems) {
  const sidebar = renderSidebar({ controller })!;
  const mounted = mountSolid(() => [
    createComponent(renderSolid, { data: { controller }, loaderPending: false, presented: true }),
    sidebar,
  ]);
  await waitForSolid(() => expect(controller.state.inventory).not.toBeNull());
  await sidebar.updateComplete;
  const page = mounted.container.querySelector<HTMLElement>("openclaw-systems-page")!;
  return { page, sidebar, unmount: mounted.unmount };
}

describe("Systems workspace", () => {
  it("shows and refreshes backup health on the landing view without machines", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<BackupStatusResult>();
    const backups = vi
      .fn<() => Promise<BackupStatusResult>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ targets: [], schedules: [], locations: [] });
    const { controller, request } = harness(
      async () => [],
      () => [],
      backups,
    );
    const { page } = await mount(controller);
    expect(page.querySelector(".systems-heading h1")?.textContent).toBe("Systems");
    expect(page.querySelectorAll(".systems-backups")).toHaveLength(1);
    expect(page.querySelector(".systems-backups")?.textContent).toContain("Loading backups…");
    pending.reject(new Error("Backup history unavailable"));
    await pending.promise.catch(() => {});
    flush();
    expect(page.querySelector('.systems-backups [role="alert"]')?.textContent).toContain(
      "Backup history unavailable",
    );
    await controller.refreshBackups();
    flush();
    expect(page.querySelector(".systems-backups")?.textContent).toContain("No backups recorded —");
    expect(page.querySelector(".systems-backups code")?.textContent).toBe(
      "openclaw backup enable --to <location>",
    );
    const backupReads = () => request.mock.calls.filter(([method]) => method === "backup.status");
    expect(backupReads()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(backupReads()).toHaveLength(3);
  });

  it("renders backup outcomes and namespace-owned schedules, probing storage only on request", async () => {
    const now = Date.UTC(2026, 8, 30, 12);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const success = {
      id: "backup-ok",
      createdAt: now - 3_600_000,
      archivePath: "/scratch/backup.tar.gz",
      kind: "archive" as const,
      status: "ok" as const,
      target: "offsite",
      location: {
        name: "offsite",
        provider: "filesystem",
        locationId: "fixture-location",
        namespace: "gateway",
        key: "20260930T110000Z-12345678.tar.gz",
        plaintextBytes: 1024,
        storedBytes: 2048,
      },
    };
    const namespaceTargets = ["host-a", undefined].map((namespace) => {
      const latest = {
        id: "other-namespace-ok",
        createdAt: now,
        archivePath: "storage://offsite/backup.tar.gz",
        kind: "archive" as const,
        status: "ok" as const,
        target: "offsite",
        namespace,
      };
      return { kind: latest.kind, target: latest.target, namespace, latest, latestOk: latest };
    });
    const gitTargets = [undefined, "Git remote rejected the push: permission denied."].map(
      (error) => {
        const latest = {
          id: "git-push-failed",
          createdAt: now - 3_600_000,
          archivePath: "/backups/git",
          target: "/backups/git",
          kind: "git" as const,
          status: "ok" as const,
          pushFailed: true as const,
          ...(error ? { error } : {}),
        };
        return { kind: latest.kind, target: latest.target, latest, latestOk: latest };
      },
    );
    const external = {
      id: "external-ok",
      createdAt: now,
      kind: "external" as const,
      status: "ok" as const,
      archivePath: "restic",
      bytes: 4096,
    };
    const { controller, request } = harness(undefined, undefined, async () => ({
      targets: [
        {
          kind: "archive",
          target: "offsite",
          namespace: "gateway",
          latest: {
            ...success,
            id: "backup-failed",
            status: "failed",
            createdAt: now,
            error: "Disk disconnected. Run openclaw storage test offsite.",
          },
          latestOk: success,
        },
        {
          kind: "external",
          target: "restic",
          latest: external,
          latestOk: external,
        },
        ...namespaceTargets,
        ...gitTargets,
      ],
      schedules: [
        {
          id: "scheduled",
          mode: "offsite",
          target: "offsite",
          namespace: "gateway",
          enabled: true,
          everyMs: 86_400_000,
          nextRunAtMs: now + 3_600_000,
        },
        {
          id: "host-b-schedule",
          mode: "offsite",
          target: "offsite",
          namespace: "host-b",
          enabled: true,
          everyMs: 86_400_000,
          nextRunAtMs: now + 3_600_000,
        },
      ],
      locations: [
        {
          name: "offsite",
          provider: "filesystem",
          displayTarget: "/Volumes/Archive/openclaw",
          encrypted: true,
        },
      ],
    }));
    const { page } = await mount(controller);
    const section = page.querySelector(".systems-backups")!;
    expect(section.textContent).toMatch(/Last success: .*ago/);
    expect(section.textContent).toContain("2 KB");
    expect(section.textContent).toContain("/Volumes/Archive/openclaw");
    expect(section.textContent).toContain("Next run:");
    expect(section.textContent).toContain("Disk disconnected. Run openclaw storage test offsite.");
    expect(section.querySelectorAll('[data-status="ok"]')).toHaveLength(3);
    const rows = [...section.querySelectorAll(".systems-backup")];
    expect(rows).toHaveLength(6);
    for (const row of rows.slice(2, 4)) {
      expect(row.textContent).not.toContain("Next run:");
    }
    expect(section.querySelector(".systems-backups__hint")?.textContent).toContain("Next run:");
    for (const [index, target] of gitTargets.entries()) {
      const backup = rows[index + 4]!;
      expect(backup.getAttribute("data-status")).toBe("failed");
      expect(backup.querySelector(".systems-backup__state")?.textContent?.trim()).toBe(
        "Push failed",
      );
      expect(backup.textContent).toMatch(/Last local success: .*ago/);
      expect(backup.querySelector(".systems-backup__error")?.textContent).toBe(
        target.latest.error ??
          "Local backup succeeded, but pushing to the Git remote failed. Check the remote and retry.",
      );
    }
    expect(
      request.mock.calls.filter(([method]) => method === "storage.locations.probe"),
    ).toHaveLength(0);
    const probe = createDeferred<{ state: "ok"; freeBytes: number }>();
    request.mockReturnValueOnce(probe.promise);
    section.querySelector<HTMLButtonElement>('[aria-label="Check offsite"]')!.click();
    flush();
    expect(section.querySelector<HTMLButtonElement>('[aria-label="Check offsite"]')?.disabled).toBe(
      true,
    );
    probe.resolve({ state: "ok", freeBytes: 1024 ** 3 });
    await probe.promise;
    flush();
    expect(section.textContent).toContain("Available");
    expect(section.textContent).toContain("1 GB free");
    expect(request).toHaveBeenCalledWith(
      "storage.locations.probe",
      { name: "offsite" },
      expect.anything(),
    );
    controller.select(worker.id);
    flush();
    expect(page.querySelector(".systems-backups")).toBeNull();
  });

  it("discards a backup response from the previous connection", async () => {
    const pending = createDeferred<BackupStatusResult>();
    const { controller, gateway } = harness(undefined, undefined, () => pending.promise);
    const { page } = await mount(controller);
    gateway.publish({ phase: "offline" });
    pending.resolve({
      targets: [],
      schedules: [],
      locations: [{ name: "old-host", provider: "filesystem", encrypted: false }],
    });
    await pending.promise;
    flush();
    expect(controller.state.backups).toBeNull();
    expect(page.querySelector(".systems-backups")?.textContent).not.toContain("old-host");
  });

  it("defers hidden initial and event reads, preserving inventory until visible recovery", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const gatewayHost = { ...host, desktop: false };
    let environments = [gatewayHost, worker, offline];
    const { controller, gateway, request } = harness(async () => environments);
    mountSolid(() =>
      createComponent(renderSolid, { data: { controller }, loaderPending: false, presented: true }),
    );
    flush();
    await vi.advanceTimersByTimeAsync(0);
    const statusReads = () => request.mock.calls.filter(([method]) => method === "system.info");
    expect(statusReads()).toHaveLength(0);
    expect(controller.state.inventory).toBeNull();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(statusReads()).toHaveLength(1);
    const inventory = controller.state.inventory;
    expect(inventory?.gatewaySystemInfo).toEqual(systemInfo);
    controller.updatePresentation({ showStats: !controller.state.showStats });
    expect(controller.state.showStats || controller.state.showDetails).toBe(false);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    environments = [gatewayHost, { ...worker, id: "worker-after-hidden", desktop: false }];
    gateway.publishEvent("presence", {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statusReads()).toHaveLength(1);
    expect(controller.state.inventory).toBe(inventory);
    expect(controller.state.inventory?.errors).toEqual({});
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(1);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(statusReads()).toHaveLength(2);
    expect(controller.state.inventory?.errors).toEqual({});
    expect(controller.sampledAtMs()).toBe(Date.now());
    expect(controller.state.rows.map((row) => row.environment.id)).toEqual([
      "gateway",
      "worker-after-hidden",
    ]);
    expect(
      controller.state.rows.find((row) => row.environment.id === "worker-after-hidden")?.environment
        .desktop,
    ).toBe(false);
    expect(controller.needsInventoryRefresh()).toBe(false);
  });

  it("keeps desktop setup active through route refreshes and renders rejected writes", async () => {
    const pending = createDeferred<boolean>();
    const { controller, context } = harness(async () => [
      { ...host, desktopSetup: { state: "ready" } },
    ]);
    vi.spyOn(context.runtimeConfig, "ensureLoaded").mockResolvedValue();
    const patch = vi.spyOn(context.runtimeConfig, "patch").mockReturnValue(pending.promise);
    const [route, setRoute] = createSignal({
      data: { controller },
      loaderPending: false,
      presented: true,
    });
    const mounted = mountSolid(() =>
      createComponent(renderSolid, {
        get data() {
          return route().data;
        },
        get loaderPending() {
          return route().loaderPending;
        },
        get presented() {
          return route().presented;
        },
      }),
    );
    await waitForSolid(() => expect(controller.state.inventory).not.toBeNull());
    const enable = mounted.container.querySelector<HTMLButtonElement>(".systems-state button")!;
    enable.click();
    await waitForSolid(() => expect(patch).toHaveBeenCalledOnce());
    setRoute({ data: { controller }, loaderPending: true, presented: true });
    flush();
    expect(mounted.container.querySelector(".systems-state button")).toBe(enable);
    expect(enable.disabled).toBe(true);
    pending.reject(new Error("Desktop configuration could not be saved"));
    await waitForSolid(() =>
      expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Desktop configuration could not be saved",
      ),
    );
    expect(enable.disabled).toBe(false);
  });

  it("updates desktop setup when only the configuration owner publishes", async () => {
    const { controller, context } = harness(async () => [
      { ...host, desktopSetup: { state: "ready" } },
    ]);
    const { page } = await mount(controller);
    expect(page.querySelector(".systems-state button")?.textContent).toContain(
      "Enable desktop access in OpenClaw",
    );
    const request = vi.spyOn(context.gateway.snapshot.client!, "request");
    request.mockResolvedValueOnce({
      config: { desktop: { host: { enabled: true } } },
      hash: "enabled",
      valid: true,
    });
    await context.runtimeConfig.refresh();
    await waitForSolid(() =>
      expect(page.querySelector(".systems-state h2")?.textContent).toBe(
        "Desktop access is enabled",
      ),
    );
    expect(page.querySelector(".systems-state button")).toBeNull();

    request.mockResolvedValueOnce({
      config: { desktop: { host: { enabled: false } } },
      hash: "disabled",
      valid: true,
    });
    await context.runtimeConfig.refresh();
    await waitForSolid(() =>
      expect(page.querySelector(".systems-state button")?.textContent).toContain(
        "Enable desktop access in OpenClaw",
      ),
    );
  });

  it.each(["selection", "authority"])(
    "cancels pending desktop enablement when %s changes",
    async (change) => {
      const loaded = createDeferred();
      const { controller, context, gateway } = harness(async () => [
        { ...host, desktopSetup: { state: "ready" } },
        { ...worker, desktop: false },
      ]);
      vi.spyOn(context.runtimeConfig, "ensureLoaded").mockReturnValue(loaded.promise);
      const patch = vi.spyOn(context.runtimeConfig, "patch");
      const { page } = await mount(controller);
      page.querySelector<HTMLButtonElement>(".systems-state button")!.click();
      await waitForSolid(() => expect(controller.desktopSetupBusy()).toBe(true));
      if (change === "selection") {
        controller.select(worker.id);
      } else {
        gateway.publish({
          hello: gatewayHelloForMethods(
            ["environments.list", "node.list", "system.info", "config.get", "config.patch"],
            ["operator.read"],
          ),
        });
      }
      loaded.resolve();
      await waitForSolid(() => expect(controller.desktopSetupBusy()).toBe(false));
      expect(patch).not.toHaveBeenCalled();
    },
  );

  it("sorts and filters the machine inventory without replacing the selected machine", async () => {
    // Open menus need frame boundaries instead of the sidebar fixture's recursive microtasks.
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const environments: EnvironmentSummary[] = [
      host,
      { ...offline, id: "node:delta", label: "Delta laptop" },
      // Auxiliary node data says disconnected; the environment inventory owns availability.
      { ...offline, label: "Zulu laptop", status: "available" },
      { ...offline, id: "node:alpha", label: "Alpha laptop" },
      { ...offline, id: "node:beta", label: "Beta laptop", status: "available" },
      { ...worker, desktop: false },
      {
        ...worker,
        id: "worker-starting",
        label: "Preparing worker",
        status: "starting",
        desktop: false,
      },
      {
        ...worker,
        id: "worker-offline",
        label: "Retained worker",
        status: "unavailable",
        desktop: false,
      },
    ];
    const { controller, request } = harness(async () => environments);
    const initial = await mount(controller);
    let { page, sidebar } = initial;
    expect(renderSidebar({ controller })).toBe(sidebar);
    const names = (selector = ".systems-machine__name") =>
      [...sidebar.querySelectorAll(selector)].map((entry) => entry.textContent?.trim());
    const nodeNames = () => names(".systems-group:first-of-type .systems-machine__name");
    const counts = () => names(".systems-group__count");
    const choose = async (value: string) => {
      const menu = sidebar.querySelector(".systems-filter-menu");
      const trigger = menu?.querySelector<HTMLButtonElement>(".oc-menu-trigger");
      expect(trigger).toBeTruthy();
      trigger!.click();
      await waitForSolid(() => expect(trigger!.getAttribute("aria-expanded")).toBe("true"));
      vi.advanceTimersToNextFrame();
      const item = menu?.querySelector<HTMLButtonElement>(`.oc-menu-item[data-value="${value}"]`);
      expect(item).toBeTruthy();
      item!.click();
      vi.advanceTimersToNextFrame();
      await sidebar.updateComplete;
      flush();
    };
    const search = async (value: string) => {
      const input = sidebar.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sidebar.updateComplete;
    };

    expect(nodeNames()).toEqual(["Beta laptop", "Zulu laptop", "Alpha laptop", "Delta laptop"]);
    expect(counts()).toEqual(["4", "3"]);
    const selected = [...sidebar.querySelectorAll<HTMLButtonElement>(".systems-machine")].find(
      (button) => button.querySelector(".systems-machine__name")?.textContent === "Zulu laptop",
    );
    selected!.click();
    flush();

    await choose("sort:name");
    expect(nodeNames()).toEqual(["Alpha laptop", "Beta laptop", "Delta laptop", "Zulu laptop"]);
    await choose("sort:offline-first");
    expect(nodeNames()).toEqual(["Alpha laptop", "Delta laptop", "Beta laptop", "Zulu laptop"]);
    await choose("status:offline");
    expect(names()).toEqual(["Alpha laptop", "Delta laptop", "Retained worker"]);
    expect(counts()).toEqual(["2", "1"]);
    expect(page.querySelector(".systems-heading h1")?.textContent).toBe("Zulu laptop");
    expect(page.querySelector<HTMLSelectElement>(".systems-mobile-picker")?.value).toBe(offline.id);

    await choose("status:online");
    expect(names()).toEqual(["Test Gateway", "Beta laptop", "Zulu laptop", "Cloud worker"]);
    await search("  ALPHA  ");
    expect(names()).toEqual([]);
    expect(counts()).toEqual([]);
    expect(sidebar.querySelector(".systems-sidebar__empty")?.textContent).toBe(
      "No machines match your search or filters.",
    );
    await choose("status:all");
    expect(names()).toEqual(["Alpha laptop"]);
    await choose("status:offline");
    expect(names()).toEqual(["Alpha laptop"]);
    expect(counts()).toEqual(["1"]);
    expect(controller.state.selectedId).toBe(offline.id);
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(1);

    initial.unmount();
    ({ page, sidebar } = await mount(controller));
    await waitForSolid(() => expect(controller.loading()).toBe(false));
    await sidebar.updateComplete;
    expect(names()).toEqual(["Alpha laptop"]);
    expect(page.querySelector(".systems-heading h1")?.textContent).toBe("Zulu laptop");
    await search("");
    expect(names()).toEqual(["Alpha laptop", "Delta laptop", "Retained worker"]);
    await choose("status:all");
    expect(nodeNames()).toEqual(["Alpha laptop", "Delta laptop", "Beta laptop", "Zulu laptop"]);
    expect(names()).toContain("Preparing worker");
  });

  it("keeps disk histories attached to mount paths through reordering, removal, and return", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { controller, request } = harness();
    const { page } = await mount(controller);
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
    await waitForSolid(() =>
      expect(page.querySelector(".sparkline-tile__value")?.textContent?.trim()).toBe("2.00"),
    );
    const points = () =>
      page.querySelector(".sparkline-tile__chart polyline")?.getAttribute("points")?.split(" ");
    expect(points()).toHaveLength(2);
    expect(page.querySelector('.systems-metrics[data-stale="false"]')).not.toBeNull();
    clock.mockReturnValue(now + 30_000);
    request.mockRejectedValueOnce(new Error("Telemetry unavailable"));
    await controller.refreshTelemetry();
    flush();
    expect(points()).toHaveLength(2);
    expect(page.querySelector('.systems-metrics[data-stale="true"]')).not.toBeNull();
    expect(page.querySelector(".systems-sample-time")?.textContent).toContain("Last reported");
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
    const calls = request.mock.calls.length;
    gateway.publishEvent("node.hostStats", { nodeId: "unrelated-node" });
    expect(request.mock.calls).toHaveLength(calls);
    controller.select(node.id);
    const readings = () =>
      [...page.querySelectorAll(".sparkline-tile__value")].map((tile) => tile.textContent?.trim());
    await waitForSolid(() => expect(readings()).toEqual(["2.00", "8.0 GB", "256 GB"]));
    expect(page.querySelector('.systems-metrics[data-stale="false"]')).not.toBeNull();
    expect(page.querySelectorAll(".sparkline-tile__chart")).toHaveLength(0);

    stats = { ...stats, loadAverage: [4, 2, 1], updatedAtMs: stats.updatedAtMs + 60_000 };
    await controller.refreshTelemetry();
    await waitForSolid(() => expect(readings()[0]).toBe("4.00"));
    const chartPoints = () =>
      page.querySelector(".sparkline-tile__chart polyline")?.getAttribute("points")?.split(" ");
    expect(chartPoints()).toHaveLength(2);
    await controller.refreshTelemetry();
    flush();
    expect(chartPoints()).toHaveLength(2);
    controller.select(host.id);
    await waitForSolid(() => expect(readings()[0]).toBe("0.50"));
    controller.select(node.id);
    await waitForSolid(() => expect(readings()[0]).toBe("4.00"));
    expect(chartPoints()).toHaveLength(2);

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
    expect(page.textContent).toContain("This machine is offline");
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

  it("shares inventory, keeps a single view-only connection through presentation changes, and retains a removed selection", async () => {
    let environments = [host, worker, offline];
    const { controller, request } = harness(async () => environments);
    const disconnect = vi.fn();
    const handle = createConnectionHandle({ disconnect });
    const connect = vi
      .spyOn(DesktopClient.prototype, "connect")
      .mockImplementation(async (options) => {
        options.onConnect?.();
        return handle;
      });
    const mounted = await mount(controller);
    let page = mounted.page;
    const { sidebar, unmount } = mounted;
    expect(sidebar.querySelectorAll(".systems-machine")).toHaveLength(3);
    expect(page.textContent).toContain("No desktop available");
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(1);
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
    expect(viewer?.hasAttribute("embedded")).toBe(true);
    expect(viewer?.embedded).toBe(true);
    controller.updatePresentation({ showStats: !controller.state.showStats });
    controller.updatePresentation({ showDetails: !controller.state.showDetails });
    await controller.refresh();
    flush();
    expect(page.querySelector("openclaw-desktop-panel")).toBe(viewer);
    expect(connect).toHaveBeenCalledOnce();
    expect(page.querySelector<HTMLSelectElement>(".systems-mobile-picker")?.value).toBe(worker.id);
    unmount();
    ({ page } = await mount(controller));
    await waitForSolid(() => expect(controller.loading()).toBe(false));
    flush();
    expect(controller.state.selectedId).toBe(worker.id);
    expect(page.querySelector<HTMLSelectElement>(".systems-mobile-picker")?.value).toBe(worker.id);
    expect(page.querySelector("openclaw-desktop-panel")?.requestedSource).toBe(worker.id);
    await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
    disconnect.mockClear();
    environments = [host, offline];
    await controller.refresh();
    flush();
    expect(controller.state.selectedId).toBe(worker.id);
    expect(page.textContent).toContain("This machine is no longer listed");
    expect(page.querySelector<HTMLSelectElement>(".systems-mobile-picker")?.value).toBe("");
    expect(page.querySelector("openclaw-desktop-panel")).toBeNull();
    await waitForSolid(() => expect(handle.disconnect).toHaveBeenCalled());
    window.dispatchEvent(
      new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, {
        detail: { open: true, environmentId: "worker-no-longer-known" },
      }),
    );
    flush();
    expect(controller.state.selectedId).toBe("worker-no-longer-known");
    expect(page.textContent).toContain("This machine is no longer listed");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("keeps selection across route activation and drops late work after departure or gateway replacement", async () => {
    const delayed = createDeferred<EnvironmentSummary[]>();
    const { controller, gateway, request } = harness(() => delayed.promise);
    const [data, setData] = createSignal<SystemsRouteData>();
    const [presented, setPresented] = createSignal(true);
    const mounted = mountSolid(() =>
      createComponent(renderSolid, {
        get data() {
          return data();
        },
        loaderPending: false,
        get presented() {
          return presented();
        },
      }),
    );
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
    controller.select(worker.id);
    setPresented(false);
    flush();
    setPresented(true);
    await waitForSolid(() => expect(controller.loading()).toBe(false));
    expect(controller.state.selectedId).toBe(worker.id);
    expect(mounted.container.querySelector("openclaw-systems-page")).toBe(page);
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
    const calls = replacement.request.mock.calls.length;
    window.dispatchEvent(
      new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, {
        detail: { open: true, environmentId: worker.id },
      }),
    );
    replacement.gateway.publishEvent("presence", {});
    expect(replacement.request.mock.calls).toHaveLength(calls);
    expect(replacement.controller.state.selectedId).toBe(host.id);
  });
});

/* @vitest-environment jsdom */
import type { EnvironmentSummary, SystemInfoResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { DesktopClient } from "../../components/desktop/desktop-client.ts";
import { createConnectionHandle } from "../../components/desktop/desktop-panel.test-support.ts";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { setupSidebarTest } from "../../test-helpers/app-sidebar-setup.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
} from "../../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { SystemsController } from "./systems-controller.ts";
import "./systems-page.ts";
import "./systems-sidebar.ts";

setupSidebarTest();
afterEach(() => vi.restoreAllMocks());

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
) {
  const request = vi.fn(async (method: string) => {
    if (method === "environments.list") {
      return { environments: await inventory() };
    }
    if (method === "system.info") {
      return systemInfo;
    }
    if (method === "node.list") {
      return {
        nodes: [
          {
            nodeId: "offline",
            connected: false,
            hostStats: {
              cpuCount: 2,
              memoryTotalBytes: 4096,
              memoryFreeBytes: 2048,
              updatedAtMs: Date.now(),
            },
          },
        ],
      };
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
  });
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: gatewayHelloForMethods(
      ["environments.list", "node.list", "system.info", "desktop.observe"],
      ["operator.admin"],
    ),
  });
  const context = createContext(gateway.gateway, createSessions("main", []));
  Object.assign(context, { basePath: "", navigate: vi.fn() });
  const controller = new SystemsController(context);
  return { controller, gateway, context, request };
}

async function mount(controller: SystemsController) {
  const page = document.createElement("openclaw-systems-page");
  const sidebar = document.createElement("openclaw-systems-sidebar");
  page.routeData = { controller };
  sidebar.controller = controller;
  document.body.append(page, sidebar);
  await vi.waitFor(() => expect(controller.inventory).not.toBeNull());
  await page.updateComplete;
  await sidebar.updateComplete;
  return { page, sidebar };
}

describe("Systems workspace", () => {
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
    const { page, sidebar } = await mount(controller);
    expect(sidebar.querySelectorAll(".systems-machine")).toHaveLength(3);
    expect(page.textContent).toContain("No desktop available");
    expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(1);
    const entry = [...sidebar.querySelectorAll<HTMLButtonElement>(".systems-machine")].find(
      (button) => button.textContent?.includes("Cloud worker"),
    );
    entry!.click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: worker.id },
      control: false,
    });
    const viewer = page.querySelector("openclaw-desktop-panel");
    expect(viewer?.hasAttribute("embedded")).toBe(true);
    expect(viewer?.embedded).toBe(true);
    controller.toggleStats();
    controller.toggleDetails();
    await controller.refresh();
    await page.updateComplete;
    expect(page.querySelector("openclaw-desktop-panel")).toBe(viewer);
    expect(connect).toHaveBeenCalledOnce();
    environments = [host, offline];
    await controller.refresh();
    await page.updateComplete;
    expect(controller.selectedId).toBe(worker.id);
    expect(page.textContent).toContain("This machine is no longer listed");
    expect(page.querySelector<HTMLSelectElement>(".systems-mobile-picker")?.value).toBe("");
    expect(page.querySelector("openclaw-desktop-panel")).toBeNull();
    expect(handle.disconnect).toHaveBeenCalled();
    window.dispatchEvent(
      new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, {
        detail: { open: true, environmentId: "worker-no-longer-known" },
      }),
    );
    await page.updateComplete;
    expect(controller.selectedId).toBe("worker-no-longer-known");
    expect(page.textContent).toContain("This machine is no longer listed");
    expect(connect).toHaveBeenCalledOnce();
  });

  it("keeps a retained worker selected in the mobile picker after remount", async () => {
    const { controller } = harness();
    vi.spyOn(DesktopClient.prototype, "connect").mockImplementation(async (options) => {
      options.onConnect?.();
      return createConnectionHandle();
    });
    const first = await mount(controller);
    controller.select(worker.id);
    await first.page.updateComplete;
    expect(first.page.querySelector<HTMLSelectElement>(".systems-mobile-picker")?.value).toBe(
      worker.id,
    );
    first.page.remove();
    first.sidebar.remove();

    const second = await mount(controller);
    await vi.waitFor(() => expect(controller.loading).toBe(false));
    await second.page.updateComplete;
    expect(controller.selectedId).toBe(worker.id);
    expect(second.page.querySelector<HTMLSelectElement>(".systems-mobile-picker")?.value).toBe(
      worker.id,
    );
    expect(second.page.querySelector("openclaw-desktop-panel")?.requestedSource).toBe(worker.id);
  });

  it("shows offline last-known telemetry without creating a desktop connection", async () => {
    const { controller, gateway, request } = harness();
    const connect = vi.spyOn(DesktopClient.prototype, "connect");
    const { page } = await mount(controller);
    const calls = request.mock.calls.length;
    gateway.publishEvent("node.hostStats", { nodeId: "unrelated-node" });
    expect(request.mock.calls).toHaveLength(calls);
    controller.select(offline.id);
    await page.updateComplete;
    expect(page.textContent).toContain("This machine is offline");
    expect(page.textContent).toContain("Last reported");
    expect(page.querySelector('.systems-metrics[data-stale="true"]')).not.toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps selection across route activation and drops late work after departure or gateway replacement", async () => {
    const delayed = createDeferred<EnvironmentSummary[]>();
    const { controller, gateway } = harness(() => delayed.promise);
    controller.setPresented(true);
    controller.setPresented(false);
    delayed.resolve([host, worker]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.inventory).toBeNull();
    controller.setPresented(true);
    await vi.waitFor(() => expect(controller.inventory).not.toBeNull());
    controller.select(worker.id);
    controller.setPresented(false);
    controller.setPresented(true);
    await vi.waitFor(() => expect(controller.loading).toBe(false));
    expect(controller.selectedId).toBe(worker.id);
    // Simulate a new revision from the Gateway owner; consumers only read this property.
    Object.defineProperty(gateway.gateway, "connectionRevision", { value: 1 });
    gateway.publish({});
    expect(controller.rows).toEqual([]);
    expect(controller.selected).toBeUndefined();
    controller.setPresented(false);
  });
});

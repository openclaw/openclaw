/* @vitest-environment jsdom */
import type {
  BackupStatusResult,
  EnvironmentSummary,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { setupSidebarTest } from "../../test-helpers/app-sidebar-setup.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
} from "../../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { SystemsController } from "./systems-controller.ts";
import "./systems-page.ts";
import "./systems-sidebar.ts";

setupSidebarTest();
const runtimeConfigs: ReturnType<typeof createRuntimeConfigCapability>[] = [];
afterEach(() => {
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
};
const node: EnvironmentSummary = {
  id: "node:worker-host",
  type: "node",
  label: "Worker host",
  status: "available",
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
  uptimeMs: 1_000,
  cpuCount: 4,
  loadAverage: [0.5, 0.4, 0.3],
  memoryTotalBytes: 8_192,
  memoryFreeBytes: 4_096,
};

function harness(inventory: () => EnvironmentSummary[], nodes: () => NodeListNode[]) {
  const backups: BackupStatusResult = { targets: [], schedules: [], locations: [] };
  const request = vi.fn(async (method: string) => {
    if (method === "environments.list") {
      return { environments: inventory() };
    }
    if (method === "system.info") {
      return systemInfo;
    }
    if (method === "node.list") {
      return { nodes: nodes() };
    }
    if (method === "backup.status") {
      return backups;
    }
    throw new Error("Unexpected request: " + method);
  });
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: gatewayHelloForMethods(
      ["environments.list", "node.list", "system.info", "config.get", "config.patch"],
      ["operator.admin"],
    ),
  });
  const sessionsHarness = createSessionsHarness("main", []);
  const context = createContext(gateway.gateway, sessionsHarness.sessions);
  const runtimeConfig = createRuntimeConfigCapability(gateway.gateway);
  runtimeConfigs.push(runtimeConfig);
  Object.assign(context, { basePath: "", navigate: vi.fn(), runtimeConfig });
  return { controller: new SystemsController(context), gateway, sessionsHarness };
}

async function mount(controller: SystemsController) {
  const page = document.createElement("openclaw-systems-page");
  const sidebar = document.createElement("openclaw-systems-sidebar");
  page.routeData = { controller };
  sidebar.controller = controller;
  document.body.append(page, sidebar);
  await vi.waitFor(() => expect(controller.inventory).not.toBeNull());
  await page.updateComplete;
  return { page, sidebar };
}

function readings(page: HTMLElement): Array<string | undefined> {
  return [...page.querySelectorAll(".sparkline-tile__value")].map((tile) =>
    tile.textContent?.trim(),
  );
}

describe("Systems resource telemetry", () => {
  it("keeps the placed session name when a dedicated worker joins generic node telemetry", async () => {
    const dedicatedWorker: EnvironmentSummary = {
      id: "worker:cad-proof",
      type: "worker",
      status: "available",
      worker: {
        providerId: "crabbox",
        profileId: "cad-apple",
        nodeId: "dedicated-worker-node",
        state: "attached",
        ageMs: 1_000,
        attachedSessionIds: ["cad-proof"],
        tunnelStatus: "connected",
      },
    };
    const telemetryNode: NodeListNode = {
      nodeId: "dedicated-worker-node",
      displayName: "Cloud worker cad-apple",
      connected: true,
      paired: true,
    };
    const placedSession: GatewaySessionRow = {
      key: "agent:cad-print-engineer:proof",
      sessionId: "cad-proof",
      displayName: "Coupon geometry proof",
      kind: "direct",
      updatedAt: 2,
      placement: {
        state: "active",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 2,
        stateChangedAtMs: 2,
        environmentId: dedicatedWorker.id,
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "manifest",
        remoteWorkspaceDir: "/work",
      },
    };
    const { controller, sessionsHarness } = harness(
      () => [dedicatedWorker],
      () => [telemetryNode],
    );
    sessionsHarness.publish({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [placedSession],
      },
    });

    const { page, sidebar } = await mount(controller);
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".systems-machine__name")?.textContent?.trim()).toBe(
      "Coupon geometry proof",
    );
    expect(page.querySelector(".systems-heading h1")?.textContent?.trim()).toBe(
      "Coupon geometry proof",
    );
    expect(
      page
        .querySelector(`.systems-mobile-picker option[value="${dedicatedWorker.id}"]`)
        ?.textContent?.trim(),
    ).toBe("Coupon geometry proof");
  });

  it("graphs genuine node reports, preserves per-machine history, and leaves gaps", async () => {
    let stats: NonNullable<NodeListNode["hostStats"]> = {
      cpuCount: 8,
      loadAverage: [2, 1, 1],
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryFreeBytes: 8 * 1024 ** 3,
      diskTotalBytes: 1024 ** 4,
      diskAvailableBytes: 256 * 1024 ** 3,
      updatedAtMs: Date.now() - 60_000,
    };
    const { controller, gateway } = harness(
      () => [host, node],
      () => [{ nodeId: "worker-host", connected: true, paired: true, hostStats: stats }],
    );
    const { page } = await mount(controller);
    controller.select(node.id);
    await vi.waitFor(() => expect(readings(page)).toEqual(["2.00", "8.0 GB", "256 GB"]));
    expect(page.querySelector('.systems-metrics[data-stale="false"]')).not.toBeNull();

    stats = { ...stats, loadAverage: [4, 2, 1], updatedAtMs: stats.updatedAtMs + 60_000 };
    await controller.refreshTelemetry();
    await vi.waitFor(() => expect(readings(page)[0]).toBe("4.00"));
    const chartPoints = () =>
      page.querySelector(".sparkline-tile__chart polyline")?.getAttribute("points")?.split(" ");
    expect(chartPoints()).toHaveLength(2);

    stats = {
      ...stats,
      loadAverage: undefined,
      diskAvailableBytes: undefined,
      diskTotalBytes: undefined,
      updatedAtMs: stats.updatedAtMs + 60_000,
    };
    await controller.refreshTelemetry();
    await vi.waitFor(() => expect(readings(page)).toEqual(["–", "8.0 GB", "–"]));
    gateway.publish({ phase: "offline" });
    await vi.waitFor(() =>
      expect(page.querySelector('.systems-metrics[data-stale="true"]')).not.toBeNull(),
    );
  });

  it("refreshes dedicated worker telemetry and fails closed when reporting stops", async () => {
    const dedicatedWorker: EnvironmentSummary = {
      ...worker,
      worker: {
        providerId: "crabbox",
        profileId: "cad-apple",
        leaseId: "lease:cad-telemetry",
        nodeId: "cad-worker-node",
        state: "attached",
        ageMs: 3_000,
        attachedSessionIds: ["cad-proof"],
        tunnelStatus: "connected",
      },
    };
    let nodes: NodeListNode[] = [
      {
        nodeId: "cad-worker-node",
        connected: true,
        paired: true,
        hostStats: {
          cpuCount: 6,
          loadAverage: [1.5, 1, 0.5],
          memoryTotalBytes: 8 * 1024 ** 3,
          memoryFreeBytes: 2 * 1024 ** 3,
          diskTotalBytes: 256 * 1024 ** 3,
          diskAvailableBytes: 96 * 1024 ** 3,
          updatedAtMs: Date.now(),
        },
      },
    ];
    const { controller } = harness(
      () => [host, dedicatedWorker],
      () => nodes,
    );
    const { page } = await mount(controller);
    controller.select(dedicatedWorker.id);
    await vi.waitFor(() => expect(readings(page)).toEqual(["1.50", "6.0 GB", "96 GB"]));
    expect(page.textContent).toContain("6 cores");

    nodes = [
      {
        ...nodes[0]!,
        hostStats: {
          ...nodes[0]!.hostStats!,
          loadAverage: [2.5, 1.5, 1],
          memoryFreeBytes: 1024 ** 3,
          diskAvailableBytes: 80 * 1024 ** 3,
          updatedAtMs: nodes[0]!.hostStats!.updatedAtMs + 60_000,
        },
      },
    ];
    await controller.refreshTelemetry();
    await vi.waitFor(() => expect(readings(page)).toEqual(["2.50", "7.0 GB", "80 GB"]));

    nodes = [];
    await controller.refreshTelemetry();
    await page.updateComplete;
    expect(page.textContent).toContain("This machine has not reported resource statistics.");
    expect(page.querySelector(".systems-metrics")).toBeNull();
  });

  it("shows an explicit unreported state without dedicated node telemetry", async () => {
    const unreportedWorker: EnvironmentSummary = {
      ...worker,
      worker: {
        providerId: "static-ssh",
        profileId: "shared-lab",
        state: "attached",
        ageMs: 3_000,
        attachedSessionIds: ["shared-proof"],
        tunnelStatus: "connected",
      },
    };
    const { controller } = harness(
      () => [host, unreportedWorker],
      () => [],
    );
    const { page } = await mount(controller);
    controller.select(unreportedWorker.id);
    await page.updateComplete;
    expect(page.textContent).toContain("This machine has not reported resource statistics.");
    expect(page.querySelector(".systems-metrics")).toBeNull();
  });
});

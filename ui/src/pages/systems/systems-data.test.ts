import type {
  EnvironmentSummary,
  SessionPlacement,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  loadSystemsInventory,
  projectSystemsInventory,
  type SystemsInventory,
} from "./systems-data.ts";

afterEach(() => vi.restoreAllMocks());

const environments: EnvironmentSummary[] = [
  { id: "gateway", type: "local", status: "available" },
  { id: "node:headless", type: "node", status: "available", label: "Same name" },
  { id: "node:offline", type: "node", status: "unavailable", label: "Same name" },
  { id: "worker:active", type: "worker", status: "available", desktop: true },
  { id: "worker:retained", type: "worker", status: "unavailable" },
];
const systemInfo: SystemInfoResult = {
  machineName: "Gateway host",
  hostname: "gateway-host",
  platform: "linux",
  release: "test",
  arch: "x64",
  osLabel: "Linux",
  nodeVersion: "v26",
  pid: 1,
  uptimeMs: 1_000,
  cpuCount: 4,
  memoryTotalBytes: 8_192,
  memoryFreeBytes: 4_096,
};
const hostStats = { cpuCount: 2, memoryTotalBytes: 4_096, memoryFreeBytes: 1_024, updatedAtMs: 50 };
const inventory: SystemsInventory = {
  environments,
  nodes: [
    { nodeId: "headless", connected: true },
    { nodeId: "offline", connected: false, hostStats },
    { nodeId: "managed-cloud-node", connected: true },
  ],
  gatewaySystemInfo: systemInfo,
  errors: {},
};
const timing = { generation: 1, createdAtMs: 1, updatedAtMs: 2, stateChangedAtMs: 2 };
const active: SessionPlacement = {
  state: "active",
  ...timing,
  environmentId: "worker:active",
  activeOwnerEpoch: 1,
  workerBundleHash: "a".repeat(64),
  workspaceBaseManifestRef: "manifest",
  remoteWorkspaceDir: "/work",
};
function session(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, sessionId: key, kind: "direct", updatedAt: 1, ...fields };
}

describe("Systems inventory projection", () => {
  it("omits completed worker history while keeping running workers and unresolved cleanup", () => {
    const states = ["attached", "destroying", "orphaned", "destroyed", "failed"] as const;
    const workers: EnvironmentSummary[] = states.map((state) => ({
      id: `worker:${state}`,
      type: "worker",
      status: state === "attached" ? "available" : "unavailable",
      worker: {
        state,
        profileId: "cloud",
        providerId: "crabbox",
        ...(state !== "failed" ? { leaseId: `lease:${state}` } : {}),
        ageMs: 1_000,
        attachedSessionIds: [],
        tunnelStatus: "stopped",
      },
    }));
    const rows = projectSystemsInventory({ ...inventory, environments: workers }, [
      session("archived", {
        archivedAt: 2,
        placement: {
          state: "reclaimed",
          ...timing,
          environmentId: "worker:destroyed",
          activeOwnerEpoch: 1,
        },
      }),
    ]);
    expect(rows.map((row) => row.environment.id)).toEqual([
      "worker:attached",
      "worker:destroying",
      "worker:orphaned",
    ]);
  });

  it("keeps headless, offline and same-named targets without resurrecting managed node rows", () => {
    const rows = projectSystemsInventory(inventory, []);
    expect(rows.map((row) => row.environment.id)).toEqual(environments.map((entry) => entry.id));
    expect(rows[0]?.gatewaySystemInfo).toBe(systemInfo);
    expect(rows[2]?.node?.hostStats).toEqual(hostStats);
    expect(rows[2]?.node?.connected).toBe(false);
    expect(rows[3]?.node).toBeUndefined();
  });

  it("uses placement before exec bindings and keeps offline runner identity", () => {
    const placed = session("placed", {
      execNode: "headless",
      placement: { ...active, runner: { kind: "device", deviceId: "offline", status: "offline" } },
    });
    const bound = session("bound", { execNode: "headless" });
    const local = session("local", { placement: { state: "local", ...timing } });
    const rows = projectSystemsInventory(inventory, [placed, bound, local]);
    expect(rows[0]?.sessions).toEqual([{ kind: "gateway", session: local }]);
    expect(rows[1]?.sessions).toEqual([{ kind: "exec-binding", session: bound }]);
    expect(rows[2]?.sessions).toEqual([{ kind: "runner", session: placed }]);
    expect(rows[3]?.sessions).toEqual([{ kind: "placement", session: placed }]);
  });

  it("retains only recorded terminal references and never guesses a prior device or Gateway fallback", () => {
    const reclaimed = session("reclaimed", {
      execNode: "headless",
      placement: {
        state: "reclaimed",
        ...timing,
        environmentId: "worker:retained",
        activeOwnerEpoch: 1,
      },
    });
    const failed = session("failed", {
      placement: { state: "failed", ...timing, recoveryError: "Provisioning failed" },
    });
    const requested = session("requested", {
      execNode: "headless",
      placement: { state: "requested", ...timing },
    });
    const moved = session("moved", {
      placement: active,
      placementMove: { target: { kind: "device", deviceId: "headless" }, updatedAtMs: 2 },
    });
    const rows = projectSystemsInventory(inventory, [reclaimed, failed, requested, moved]);
    expect(rows[0]?.sessions).toEqual([]);
    expect(rows[1]?.sessions).toEqual([]);
    expect(rows[4]?.sessions).toEqual([{ kind: "retained-placement", session: reclaimed }]);
    expect(rows[3]?.sessions).toEqual([{ kind: "placement", session: moved }]);
  });

  it("does not fabricate rows for a removed target or resolve exec aliases by display name", () => {
    const rows = projectSystemsInventory(inventory, [
      session("removed", { placement: { ...active, environmentId: "worker:removed" } }),
      session("alias", { execNode: "Same name" }),
    ]);
    expect(rows).toHaveLength(environments.length);
    expect(rows.flatMap((row) => row.sessions)).toEqual([]);
  });
});

describe("Systems inventory loading", () => {
  it("loads the existing read contracts and does not create a second session inventory", async () => {
    const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValueOnce({ environments })
      .mockResolvedValueOnce({ nodes: inventory.nodes })
      .mockResolvedValueOnce(systemInfo);
    const controller = new AbortController();
    expect(
      await loadSystemsInventory(client, { isCurrent: () => true, signal: controller.signal }),
    ).toEqual(inventory);
    expect(
      request.mock.calls.map(([method, params, options]) => [method, params, options?.signal]),
    ).toEqual([
      ["environments.list", { includeDesktopSetup: true }, controller.signal],
      ["node.list", {}, controller.signal],
      ["system.info", {}, controller.signal],
    ]);
  });

  it("keeps canonical inventory when auxiliary resource reads fail, with visible errors", async () => {
    const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
    vi.spyOn(client, "request")
      .mockResolvedValueOnce({ environments })
      .mockRejectedValueOnce(new Error("Node inventory denied"))
      .mockRejectedValueOnce(new Error("System info unavailable"));
    const result = await loadSystemsInventory(client, { isCurrent: () => true });
    expect(result).toMatchObject({ environments, nodes: [], gatewaySystemInfo: null });
    expect(result?.errors.nodes).toContain("Node inventory denied");
    expect(result?.errors.systemInfo).toContain("System info unavailable");
  });

  it("propagates inventory failure rather than synthesizing a successful list from nodes", async () => {
    const failure = new Error("Inventory unavailable");
    const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
    vi.spyOn(client, "request")
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ nodes: inventory.nodes })
      .mockResolvedValueOnce(systemInfo);
    await expect(loadSystemsInventory(client, { isCurrent: () => true })).rejects.toBe(failure);
  });

  it.each(["replacement", "abort"] as const)("discards a late result after %s", async (change) => {
    const delayed = createDeferred<{ environments: EnvironmentSummary[] }>();
    const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
    vi.spyOn(client, "request")
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce({ nodes: inventory.nodes })
      .mockResolvedValueOnce(systemInfo);
    let current = true;
    const controller = new AbortController();
    const result = loadSystemsInventory(client, {
      isCurrent: () => current,
      signal: controller.signal,
    });
    if (change === "replacement") {
      current = false;
    } else {
      controller.abort();
    }
    delayed.resolve({ environments });
    await expect(result).resolves.toBeUndefined();
  });

  it("does not dispatch an already invalidated load", async () => {
    const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
    const request = vi.spyOn(client, "request");
    await expect(loadSystemsInventory(client, { isCurrent: () => false })).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});

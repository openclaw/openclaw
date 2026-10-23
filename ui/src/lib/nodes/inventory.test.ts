// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { NodeHostStats } from "../../../../src/shared/node-host-stats.js";
import type { PairedDevice } from "./index.ts";
import {
  buildDeviceInventory,
  findGatewayPresence,
  listStaleInventoryEntries,
  listUnpairedPresence,
  resolveInventoryRemoval,
} from "./inventory.ts";

function device(overrides: Partial<PairedDevice> & { deviceId: string }): PairedDevice {
  return { publicKey: `pk-${overrides.deviceId}`, roles: ["operator"], ...overrides };
}

function firstGroup(groups: ReturnType<typeof buildDeviceInventory>) {
  return expectDefined(groups[0], "first device inventory group");
}

function inventory(
  paired: PairedDevice[] = [],
  nodes: Parameters<typeof buildDeviceInventory>[0]["nodes"] = [],
  presence?: Parameters<typeof buildDeviceInventory>[0]["presence"],
) {
  return buildDeviceInventory({ paired, nodes, presence });
}

function duplicate(deviceId: string, overrides: Partial<PairedDevice> = {}) {
  return device({ deviceId, displayName: "megaclaw", ...overrides });
}

const hostStats = {
  cpuCount: 24,
  loadAverage: [3.2, 2.8, 2.4],
  memoryTotalBytes: 192 * 1024 ** 3,
  memoryFreeBytes: 41 * 1024 ** 3,
  diskTotalBytes: 2 * 1024 ** 4,
  diskAvailableBytes: Math.round(1.2 * 1024 ** 4),
  updatedAtMs: 1_700_000_000_000,
} satisfies NodeHostStats;

describe("buildDeviceInventory", () => {
  it("keeps available device-family metadata for live and offline platform labels", () => {
    const groups = buildDeviceInventory({
      paired: [
        device({ deviceId: "live", platform: "MacIntel", deviceFamily: "Mac" }),
        device({ deviceId: "offline", platform: "MacIntel", deviceFamily: "Mac" }),
        device({ deviceId: "legacy", platform: "MacIntel" }),
        device({ deviceId: "paired-node", platform: "MacIntel", deviceFamily: "Mac" }),
        device({ deviceId: "node-fallback", platform: "MacIntel" }),
      ],
      nodes: [
        { nodeId: "node-only", platform: "MacIntel", deviceFamily: "iPad" },
        { nodeId: "paired-node", platform: "MacIntel", deviceFamily: "iPad" },
        { nodeId: "node-fallback", platform: "MacIntel", deviceFamily: "iPad" },
      ],
      presence: [{ deviceId: "live", platform: "MacIntel", deviceFamily: "iPad", ts: 1_000 }],
    });
    const entries = groups.map((group) => group.primary);
    expect(Object.fromEntries(entries.map(({ id, deviceFamily }) => [id, deviceFamily]))).toEqual({
      live: "iPad",
      offline: "Mac",
      "node-only": "iPad",
      legacy: undefined,
      "paired-node": "Mac",
      "node-fallback": "iPad",
    });
    for (const id of ["live", "legacy"]) {
      expect(entries.find((entry) => entry.id === id)?.platform).toBe("MacIntel");
    }
  });

  it("joins device records with node catalog rows by id", () => {
    const node = {
      nodeId: "node-1",
      displayName: "megaclaw",
      connected: false,
      paired: true,
      caps: ["screen"],
      commands: ["system.run"],
      version: "2026.6.11",
      coreVersion: "2026.7.2",
      uiVersion: "19.5",
      workerSlots: { total: 2, available: 1 },
      workerBundle: { status: "installed", version: "2026.8.9" },
      hostStats,
    } satisfies NonNullable<Parameters<typeof inventory>[1]>[number];
    const groups = inventory(
      [duplicate("node-1", { roles: ["operator", "node"], connected: true, lastSeenAtMs: 1_000 })],
      [node],
    );
    expect(groups).toHaveLength(1);
    expect(firstGroup(groups).primary).toMatchObject({
      id: "node-1",
      connected: true,
      roles: ["operator", "node"],
      version: "2026.6.11",
    });
    expect(firstGroup(groups).primary.node).toEqual(node);
  });

  it("preserves host stats when optional load and disk inputs are absent", () => {
    const stats = { cpuCount: 8, memoryTotalBytes: 16, memoryFreeBytes: 4, updatedAtMs: 1 };
    const groups = inventory([], [{ nodeId: "node-1", hostStats: stats }]);
    expect(firstGroup(groups).primary.node?.hostStats).toEqual(stats);
  });

  it("preserves a valid missing worker bundle status", () => {
    const node = {
      nodeId: "node-1",
      connected: true,
      paired: true,
      workerBundle: { status: "missing" },
    } satisfies NonNullable<Parameters<typeof inventory>[1]>[number];
    expect(firstGroup(inventory([], [node])).primary.node?.workerBundle).toEqual({
      status: "missing",
    });
  });

  it("joins presence case-insensitively and prefers its display metadata", () => {
    const groups = buildDeviceInventory({
      paired: [device({ deviceId: "NODE-1", displayName: "megaclaw", platform: "linux" })],
      nodes: [
        {
          nodeId: "NODE-1",
          connected: true,
          paired: true,
          platform: "windows",
          version: "old",
          modelIdentifier: "old-model",
        },
      ],
      presence: [
        {
          deviceId: "node-1",
          platform: "macos",
          version: "2026.7.11",
          modelIdentifier: "Mac16,6",
          ts: 4_000,
        },
      ],
    });

    expect(firstGroup(groups).primary).toMatchObject({
      platform: "macos",
      version: "2026.7.11",
      modelIdentifier: "Mac16,6",
      lastSeenAtMs: 4_000,
    });
    expect(firstGroup(groups).primary.presence?.deviceId).toBe("node-1");
  });

  it("does not let one disconnect beacon override server-computed connectivity", () => {
    const groups = inventory(
      [device({ deviceId: "browser-1", displayName: "Browser", connected: true })],
      [],
      [{ instanceId: "BROWSER-1", reason: "disconnect", ts: 1_000 }],
    );
    expect(firstGroup(groups).primary.connected).toBe(true);
  });

  it("prefers operatorLabel over displayName clientId and deviceId for display name", () => {
    const groups = inventory([
      device({
        deviceId: "dev-label",
        operatorLabel: "Kitchen Mac",
        displayName: "MacBook Pro",
        clientId: "openclaw-macos",
      }),
      device({
        deviceId: "dev-display",
        displayName: "Living Room iPad",
        clientId: "openclaw-ios",
      }),
      device({ deviceId: "dev-client", clientId: "openclaw-control-ui" }),
      device({ deviceId: "dev-id-only" }),
    ]);
    expect(Object.fromEntries(groups.map(({ primary }) => [primary.id, primary.name]))).toEqual({
      "dev-label": "Kitchen Mac",
      "dev-display": "Living Room iPad",
      "dev-client": "openclaw-control-ui",
      "dev-id-only": "dev-id-only",
    });
  });

  it("groups duplicate pairings by display name with the freshest entry first", () => {
    const groups = buildDeviceInventory({
      paired: [
        device({ deviceId: "old-1", displayName: "MacBook", lastSeenAtMs: 1_000 }),
        device({ deviceId: "new-1", displayName: "MacBook", lastSeenAtMs: 3_000 }),
        device({ deviceId: "mid-1", displayName: "macbook", lastSeenAtMs: 2_000 }),
      ],
      nodes: [],
    });

    expect(groups).toHaveLength(1);
    expect(firstGroup(groups).primary.id).toBe("new-1");
    expect(firstGroup(groups).duplicates.map((entry) => entry.id)).toEqual(["mid-1", "old-1"]);
  });

  it("prefers connected entries as group primary over fresher offline ones", () => {
    const groups = buildDeviceInventory({
      paired: [
        device({ deviceId: "offline-1", displayName: "megaclaw", lastSeenAtMs: 9_000 }),
        device({
          deviceId: "live-1",
          displayName: "megaclaw",
          roles: ["node"],
          lastSeenAtMs: 1_000,
        }),
      ],
      nodes: [{ nodeId: "live-1", connected: true, paired: true }],
    });

    expect(firstGroup(groups).primary.id).toBe("live-1");
    expect(firstGroup(groups).duplicates.map((entry) => entry.id)).toEqual(["offline-1"]);
  });

  it("groups anonymous records by client identity and keeps unknown ids separate", () => {
    const groups = inventory([
      device({ deviceId: "cli-1", clientId: "cli", clientMode: "cli", lastSeenAtMs: 2_000 }),
      device({ deviceId: "cli-2", clientId: "cli", clientMode: "cli", lastSeenAtMs: 1_000 }),
      device({ deviceId: "anon-1" }),
      device({ deviceId: "anon-2" }),
    ]);
    const keys = groups.map((group) => group.key);
    expect(keys).toContain("client:cli:cli");
    expect(keys).toContain("id:anon-1");
    expect(keys).toContain("id:anon-2");
    const cliGroup = groups.find((group) => group.key === "client:cli:cli");
    expect(cliGroup?.primary.id).toBe("cli-1");
    expect(cliGroup?.duplicates.map((entry) => entry.id)).toEqual(["cli-2"]);
    expect(cliGroup?.name).toBe("cli");
  });

  it("keeps legacy node-only rows and marks them with the node role", () => {
    const groups = buildDeviceInventory({
      paired: [],
      nodes: [{ nodeId: "legacy-1", displayName: "clawmac", paired: true, connected: false }],
    });

    expect(groups).toHaveLength(1);
    expect(firstGroup(groups).primary.roles).toEqual(["node"]);
    expect(firstGroup(groups).primary.device).toBeUndefined();
  });

  it("flags silent trusted-cidr and ssh-verified pairings as auto-approved", () => {
    const groups = buildDeviceInventory({
      paired: [
        device({ deviceId: "cli-1", clientId: "cli", approvedVia: "silent" }),
        device({ deviceId: "cidr-1", displayName: "megaclaw", approvedVia: "trusted-cidr" }),
        device({ deviceId: "ssh-1", displayName: "remote-mac", approvedVia: "ssh-verified" }),
        device({ deviceId: "owner-1", displayName: "iPhone", approvedVia: "owner" }),
      ],
      nodes: [],
    });
    const byId = new Map(groups.map((group) => [group.primary.id, group.primary]));
    expect(byId.get("cli-1")?.autoApproved).toBe(true);
    expect(byId.get("cidr-1")?.autoApproved).toBe(true);
    expect(byId.get("ssh-1")?.autoApproved).toBe(true);
    expect(byId.get("owner-1")?.autoApproved).toBe(false);
  });
});

describe("listStaleInventoryEntries", () => {
  it("treats server-reported device connectivity as live for operator-only entries", () => {
    const cli = (deviceId: string, lastSeenAtMs: number, connected = false) =>
      device({ deviceId, clientId: "cli", approvedVia: "silent", lastSeenAtMs, connected });
    const groups = inventory([
      cli("cli-new", 3_000),
      cli("cli-live", 1_000, true),
      cli("cli-stale", 2_000),
    ]);
    expect(firstGroup(groups).primary.id).toBe("cli-live");
    expect(listStaleInventoryEntries(groups).map((entry) => entry.id)).toEqual([
      "cli-new",
      "cli-stale",
    ]);
  });

  it("lists offline auto-approved duplicates only", () => {
    const groups = inventory(
      [
        duplicate("new-1", { approvedVia: "silent", lastSeenAtMs: 3_000 }),
        duplicate("live-old", {
          roles: ["node"],
          approvedVia: "trusted-cidr",
          lastSeenAtMs: 2_000,
        }),
        duplicate("old-1", { approvedVia: "trusted-cidr", lastSeenAtMs: 1_000 }),
        duplicate("ssh-old", { approvedVia: "ssh-verified" }),
        // Owner-approved duplicates never enter the bulk sweep.
        duplicate("owner-old", { approvedVia: "owner" }),
        duplicate("legacy-old"),
      ],
      [
        { nodeId: "live-old", displayName: "megaclaw", connected: true, paired: true },
        { nodeId: "catalog-old", displayName: "megaclaw", connected: false, paired: true },
      ],
    );
    // Connected entry becomes primary; only eligible offline device records are swept.
    expect(listStaleInventoryEntries(groups).map((entry) => entry.id)).toEqual([
      "new-1",
      "old-1",
      "legacy-old",
      "ssh-old",
    ]);
  });
});

it("findGatewayPresence returns the Gateway self beacon", () => {
  const gateway = { instanceId: "gateway-1", mode: " GATEWAY ", ts: 2_000 };
  expect(findGatewayPresence([{ instanceId: "node-1", mode: "node", ts: 1_000 }, gateway])).toBe(
    gateway,
  );
});

it("listUnpairedPresence returns only live beacons with no inventory row", () => {
  const groups = inventory([duplicate("node-1")]);
  const joined = { deviceId: "NODE-1", mode: "node", ts: 1_000 };
  const gateway = { instanceId: "gateway-1", mode: "gateway", ts: 2_000 };
  const disconnected = { instanceId: "left-1", mode: "webchat", reason: "disconnect", ts: 3_000 };
  const textOnly = { text: "note from test", ts: 1_000 };
  const live = { instanceId: "webchat-1", mode: "webchat", host: "browser", ts: 4_000 };

  expect(listUnpairedPresence([joined, gateway, disconnected, textOnly, live], groups)).toEqual([
    live,
  ]);
});

describe("resolveInventoryRemoval", () => {
  it("routes node-role entries through node removal", () => {
    const groups = buildDeviceInventory({
      paired: [device({ deviceId: "node-1", roles: ["node"], displayName: "megaclaw" })],
      nodes: [],
    });
    expect(resolveInventoryRemoval(firstGroup(groups).primary)).toEqual({
      removeNode: true,
      removeDevice: false,
    });
  });

  it("routes mixed-role entries through node and device removal", () => {
    const groups = inventory([
      device({ deviceId: "mixed-1", roles: ["operator", "node"], displayName: "MacBook" }),
    ]);
    expect(resolveInventoryRemoval(firstGroup(groups).primary)).toEqual({
      removeNode: true,
      removeDevice: true,
    });
  });

  it("routes operator-only entries through device removal", () => {
    const groups = inventory([device({ deviceId: "op-1", roles: ["operator"] })]);
    expect(resolveInventoryRemoval(firstGroup(groups).primary)).toEqual({
      removeNode: false,
      removeDevice: true,
    });
  });

  it("routes legacy node-only rows through node removal", () => {
    const groups = inventory([], [{ nodeId: "legacy-1", paired: true }]);
    expect(resolveInventoryRemoval(firstGroup(groups).primary)).toEqual({
      removeNode: true,
      removeDevice: false,
    });
  });
});

// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
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

it.each([
  [true, "Mac", undefined, "iPad", "iPad"],
  [true, "Mac", undefined, undefined, "Mac"],
  [false, undefined, "iPad", undefined, "iPad"],
  [true, undefined, undefined, undefined, undefined],
  [true, "Mac", "iPad", undefined, "Mac"],
  [true, undefined, "iPad", undefined, "iPad"],
] as const)("resolves device-family precedence: %j", (paired, family, node, live, expected) => {
  const groups = inventory(
    paired ? [device({ deviceId: "id", platform: "MacIntel", deviceFamily: family })] : [],
    node ? [{ nodeId: "id", platform: "MacIntel", deviceFamily: node }] : [],
    live ? [{ deviceId: "id", platform: "MacIntel", deviceFamily: live, ts: 1_000 }] : [],
  );
  expect(firstGroup(groups).primary).toMatchObject({
    deviceFamily: expected,
    platform: "MacIntel",
  });
});

it("joins device records with node catalog rows by id and preserves node metadata", () => {
  const node = {
    nodeId: "node-1",
    paired: true,
    version: "2026.6.11",
    hostStats: { cpuCount: 8, memoryTotalBytes: 16, memoryFreeBytes: 4, updatedAtMs: 1 },
    workerBundle: { status: "missing" },
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

it("joins presence case-insensitively and prefers its display metadata", () => {
  const metadata = { platform: "macos", version: "2026.7.11", modelIdentifier: "Mac16,6" };
  const groups = inventory(
    [device({ deviceId: "NODE-1", platform: "linux" })],
    [{ nodeId: "NODE-1", platform: "windows", version: "old", modelIdentifier: "old-model" }],
    [{ deviceId: "node-1", ...metadata, ts: 4_000 }],
  );
  expect(firstGroup(groups).primary).toMatchObject({ ...metadata, lastSeenAtMs: 4_000 });
  expect(firstGroup(groups).primary.presence?.deviceId).toBe("node-1");
});

it("does not let one disconnect beacon override server-computed connectivity", () => {
  const groups = inventory(
    [device({ deviceId: "browser-1", connected: true })],
    [],
    [{ instanceId: "BROWSER-1", reason: "disconnect", ts: 1_000 }],
  );
  expect(firstGroup(groups).primary.connected).toBe(true);
});

it.each([
  [{ operatorLabel: "Kitchen", displayName: "Mac", clientId: "client" }, "Kitchen"],
  [{ displayName: "Mac", clientId: "client" }, "Mac"],
  [{ clientId: "client" }, "client"],
  [{}, "id"],
])("resolves display-name precedence for %j", (metadata, name) => {
  expect(firstGroup(inventory([device({ deviceId: "id", ...metadata })])).primary.name).toBe(name);
});

it("groups anonymous records by client identity and keeps unknown ids separate", () => {
  const groups = inventory([
    device({ deviceId: "cli-1", clientId: "cli", clientMode: "cli", lastSeenAtMs: 2_000 }),
    device({ deviceId: "cli-2", clientId: "cli", clientMode: "cli", lastSeenAtMs: 1_000 }),
    device({ deviceId: "anon-1" }),
    device({ deviceId: "anon-2" }),
  ]);
  expect(groups.map((group) => group.key)).toEqual(["client:cli:cli", "id:anon-1", "id:anon-2"]);
  const cliGroup = groups.find((group) => group.key === "client:cli:cli");
  expect(cliGroup).toMatchObject({ primary: { id: "cli-1" }, name: "cli" });
  expect(cliGroup?.duplicates.map((entry) => entry.id)).toEqual(["cli-2"]);
});
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
      duplicate("owner-old", { approvedVia: "owner" }),
      duplicate("legacy-old"),
    ],
    [
      { nodeId: "live-old", displayName: "megaclaw", connected: true, paired: true },
      { nodeId: "catalog-old", displayName: "megaclaw", connected: false, paired: true },
    ],
  );
  expect(listStaleInventoryEntries(groups).map((entry) => entry.id)).toEqual([
    "new-1",
    "old-1",
    "legacy-old",
    "ssh-old",
  ]);
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

it.each<[string, string[] | null, boolean, boolean]>([
  ["mixed", ["operator", "node"], true, true],
  ["operator", ["operator"], false, true],
  ["legacy node", null, true, false],
])("routes %s removal", (_label, roles, removeNode, removeDevice) => {
  const paired = roles ? [device({ deviceId: "id", roles })] : [];
  const nodes = roles ? [] : [{ nodeId: "id", paired: true }];
  expect(resolveInventoryRemoval(firstGroup(inventory(paired, nodes)).primary)).toEqual({
    removeNode,
    removeDevice,
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

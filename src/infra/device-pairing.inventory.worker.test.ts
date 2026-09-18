import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerDevicesCli } from "../cli/devices-cli.js";
import { collectDevicePairingHealthFindings } from "../commands/doctor-device-pairing.js";
import { deviceHandlers } from "../gateway/server-methods/devices.js";
import { nodePairingHandlers } from "../gateway/server-methods/nodes.pairing.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { listNodePairing } from "./device-pairing-node.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { listDevicePairing, listDevicePairingReadOnly } from "./device-pairing.js";
import type { DevicePairingStoreState } from "./device-pairing.types.js";

const transport = vi.hoisted(() => ({
  request: vi.fn<(method: string, opts: unknown, params: unknown) => Promise<unknown>>(),
  runtime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));
vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: transport.request,
}));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: transport.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function inventory(now: number): DevicePairingStoreState {
  const pending = (requestId: string, ts: number, refreshedAtMs?: number) => ({
    requestId,
    deviceId: `device-${requestId}`,
    publicKey: `synthetic-public-${requestId}`,
    role: "operator",
    scopes: ["operator.read"],
    ts,
    ...(refreshedAtMs === undefined ? {} : { refreshedAtMs }),
  });
  return {
    pendingById: {
      expired: pending("expired", now - 300_001),
      renewed: pending("renewed", now - 600_000, now),
      recent: pending("recent", now - 100),
    },
    pairedByDeviceId: Object.fromEntries(
      ["older", "newer"].map((deviceId, index) => [
        deviceId,
        {
          deviceId,
          publicKey: `synthetic-public-${deviceId}`,
          role: "node",
          roles: ["node"],
          approvedScopes: [],
          tokens: {
            node: {
              token: `synthetic-private-${deviceId}`,
              role: "node",
              scopes: [],
              createdAtMs: now - 2_000,
            },
          },
          createdAtMs: now - 2_000,
          approvedAtMs: now - 1_000 + index,
          nodeSurface: { createdAtMs: now - 2_000, approvedAtMs: now - 1_000 + index },
          pendingNodeSurface: {
            requestId: `surface-${deviceId}`,
            revision: "synthetic-revision",
            ts: now - 600_000 + index,
          },
        },
      ]),
    ),
  };
}

async function requestInventory(method: "device.pair.list" | "node.pair.list") {
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  const handlers = method === "device.pair.list" ? deviceHandlers : nodePairingHandlers;
  await expectDefined(
    handlers[method],
    "registered pairing inventory handler",
  )({
    req: { type: "req", id: "inventory", method, params: {} },
    params: {},
    client: null,
    respond,
    context: { hasConnectedClientsForDevice: (id: string) => id === "newer" },
  } as unknown as GatewayRequestHandlerOptions);
  expect(respond).toHaveBeenCalledOnce();
  const [ok, payload, error] = expectDefined(respond.mock.calls[0], "inventory response");
  expect(error).toBeUndefined();
  expect(ok).toBe(true);
  return payload;
}

it("keeps missing read-only state absent and bootstraps writable inventory off-thread", async () => {
  await withOpenClawTestState({ label: "pairing-inventory-cold" }, async (state) => {
    const sql = observeMainThreadSql();
    try {
      expect(await withArtifactPreservingStateReads(() => listDevicePairingReadOnly())).toEqual({
        pending: [],
        paired: [],
      });
      await expect(fs.stat(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await listDevicePairing()).toEqual({ pending: [], paired: [] });
      await closeOpenClawStateDatabaseAsync();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect((await fs.stat(state.statePath("state", "openclaw.sqlite"))).isFile()).toBe(true);
  });
});

it("preserves device expiry, node decisions, ordering and source artifacts across worker reads", async () => {
  await withOpenClawTestState({ label: "pairing-inventory" }, async (state) => {
    const stored = inventory(Date.now());
    persistDevicePairingStoreState(stored, state.stateDir, "both");
    await closeOpenClawStateDatabaseAsync();
    const before = await fs.readFile(state.statePath("state", "openclaw.sqlite"));
    const artifacts = await fs.readdir(state.statePath("state"));
    const sql = observeMainThreadSql();
    try {
      const readOnly = await withArtifactPreservingStateReads(() =>
        listDevicePairingReadOnly(state.stateDir),
      );
      expect(readOnly.pending.map((pending) => pending.requestId)).toEqual(["recent", "renewed"]);
      expect(readOnly.pending.every((pending) => !("refreshedAtMs" in pending))).toBe(true);
      expect(readOnly.paired.map((device) => device.deviceId)).toEqual(["newer", "older"]);
      await closeOpenClawStateDatabaseAsync();
      expect(await fs.readdir(state.statePath("state"))).toEqual(artifacts);
      expect(await fs.readFile(state.statePath("state", "openclaw.sqlite"))).toEqual(before);
      expect(await listDevicePairing(state.stateDir)).toEqual(readOnly);
      const nodes = await listNodePairing(state.stateDir, { includePairingGeneration: true });
      expect(nodes.pending.map((pending) => pending.requestId)).toEqual([
        "surface-newer",
        "surface-older",
      ]);
      expect(nodes.paired.map((node) => node.nodeId)).toEqual(["newer", "older"]);
      expect(nodes.paired.every((node) => Boolean(node.pairingGeneration))).toBe(true);
      await closeOpenClawStateDatabaseAsync();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("observes native mutations after a warm worker inventory without host SQL on the next list", async () => {
  await withOpenClawTestState({ label: "pairing-inventory-invalidation" }, async (state) => {
    const stored = inventory(Date.now());
    persistDevicePairingStoreState(stored, state.stateDir, "both");
    await closeOpenClawStateDatabaseAsync();
    expect((await listDevicePairing()).paired).toHaveLength(2);
    delete stored.pairedByDeviceId.newer;
    persistDevicePairingStoreState(stored, state.stateDir, "paired");
    const sql = observeMainThreadSql();
    try {
      expect((await listDevicePairing()).paired.map((device) => device.deviceId)).toEqual([
        "older",
      ]);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("serves CLI and registered node inventories from SQLite with their public presentation", async () => {
  await withOpenClawTestState({ label: "pairing-inventory-entry-points" }, async (state) => {
    persistDevicePairingStoreState(inventory(Date.now()), state.stateDir, "both");
    await closeOpenClawStateDatabaseAsync();
    transport.request.mockImplementation(async (method) => {
      expect(method).toBe("device.pair.list");
      return requestInventory("device.pair.list");
    });
    const sql = observeMainThreadSql();
    try {
      const program = new Command();
      registerDevicesCli(program);
      await program.parseAsync(["devices", "list", "--json"], { from: "user" });
      expect(transport.runtime.writeJson).toHaveBeenCalledWith({
        pending: [
          expect.objectContaining({ requestId: "recent" }),
          expect.objectContaining({ requestId: "renewed" }),
        ],
        paired: [
          expect.objectContaining({
            deviceId: "newer",
            connected: true,
            tokens: [expect.objectContaining({ role: "node" })],
          }),
          expect.objectContaining({ deviceId: "older", connected: false }),
        ],
      });
      expect(JSON.stringify(transport.runtime.writeJson.mock.calls)).not.toContain(
        "synthetic-private",
      );
      expect(JSON.stringify(transport.runtime.writeJson.mock.calls)).not.toContain(
        "approvedScopes",
      );
      expect(await requestInventory("node.pair.list")).toMatchObject({
        pending: [
          expect.objectContaining({ requestId: "surface-newer" }),
          expect.objectContaining({ requestId: "surface-older" }),
        ],
        paired: [
          expect.objectContaining({ nodeId: "newer" }),
          expect.objectContaining({ nodeId: "older" }),
        ],
      });
      await closeOpenClawStateDatabaseAsync();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("keeps Doctor's local pairing findings while moving its inventory queries off-thread", async () => {
  await withOpenClawTestState({ label: "pairing-inventory-doctor" }, async (state) => {
    persistDevicePairingStoreState(inventory(Date.now()), state.stateDir, "both");
    await closeOpenClawStateDatabaseAsync();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      const findings = await collectDevicePairingHealthFindings({
        cfg: { gateway: { mode: "local" } },
      });
      expect(
        findings
          .filter((finding) => finding.path === "devices.pending")
          .map((finding) => finding.target),
      ).toEqual(["device-recent:recent", "device-renewed:renewed"]);
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("device_pairing_"))).toEqual([]);
    } finally {
      prepare.mockRestore();
    }
  });
});

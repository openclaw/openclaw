import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { reconcileNodePairingOnConnect as reconcile } from "../gateway/node-connect-reconcile.js";
import { closeOpenClawStateDatabaseByPathAsync as closeDatabase } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase as openDatabase } from "../state/openclaw-state-db.js";
import { migrateLegacyDesktopStreamOptOuts as migrateDesktop } from "./device-pairing-node-desktop-migration.js";
import {
  approveNodePairing as approveNode,
  listNodePairing,
  requestNodePairing,
} from "./device-pairing-node.js";
import { seedNodeDevice } from "./device-pairing-node.test-support.js";
import {
  usePairingState,
  legacyNodeDevice,
  pairingTimestamps as timestamps,
} from "./device-pairing-state.test-support.js";
import {
  getPairedDevice as getDevice,
  resolveNodePairingGeneration as generationOf,
  withPairedDeviceRecords as withDevices,
} from "./device-pairing.js";
import { migrateDoctorPairingStores } from "./state-migrations.pairing.js";

const state = usePairingState("openclaw-desktop-approval-migration-");
const nodeId = "openclaw-macos";
const desktop = {
  nodeId,
  platform: "macos",
  caps: ["screen", "system"],
  commands: ["desktop.stream", "system.run"],
};
const approval = { callerScopes: ["operator.pairing", "operator.admin"] };
let baseDir: string;

beforeEach(() => {
  baseDir = state.baseDir;
});

function database() {
  return openDatabase({ env: state.env });
}

async function approveDesktopNode() {
  await seedNodeDevice(baseDir, nodeId);
  const { request } = await requestNodePairing(desktop, baseDir);
  await approveNode(request.requestId, approval, baseDir);
  return expectDefined(await getDevice(nodeId, baseDir), "approved device");
}

it.each(["desktop", "unrelated"] as const)(
  "requires interactive desktop reapproval across reopen with %s pending state",
  async (pendingKind) => {
    const before = await approveDesktopNode();
    const declaredCommands = ["desktop.stream", "system.run", "system.which"];
    const pending = await requestNodePairing(
      {
        ...desktop,
        commands: pendingKind === "desktop" ? declaredCommands : ["system.run", "system.which"],
        silent: true,
      },
      baseDir,
    );
    // Seed the legacy hint directly: current requests keep upgrades interactive.
    await withDevices(baseDir, (devices) => {
      const legacy = expectDefined(devices[nodeId]?.pendingNodeSurface, "legacy pending surface");
      legacy.silent = true;
      return { value: undefined, persist: true };
    });
    expect(await migrateDesktop({}, baseDir)).toBe(1);
    const after = expectDefined(await getDevice(nodeId, baseDir), "migrated device");
    expect(after.nodeSurface?.commands).toEqual(["system.run"]);
    expect([after.nodeSurface?.caps, after.tokens, after.roles]).toEqual([
      before.nodeSurface?.caps,
      before.tokens,
      before.roles,
    ]);
    expect(generationOf(after)?.key).not.toBe(generationOf(before)?.key);
    expect(after.pendingNodeSurface).toMatchObject({
      requestId: pending.request.requestId,
      silent: pendingKind === "unrelated",
      commands: pending.request.commands,
    });

    await closeDatabase(database().path);
    const pairedNode = expectDefined((await listNodePairing(baseDir)).paired[0], "paired node");
    const reconciled = await reconcile({
      cfg: {},
      connectParams: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: nodeId,
          version: "test",
          platform: "macos",
          deviceFamily: "Mac",
          mode: "node",
        },
        caps: desktop.caps,
        commands: declaredCommands,
      },
      pairedNode,
      initialSurfaceSilent: true,
      requestPairing: (input) => requestNodePairing(input, baseDir),
    });
    expect(reconciled.effectiveCommands).toEqual(["system.run"]);
    const reapproval = expectDefined(reconciled.pendingPairing, "interactive reapproval");
    expect(reapproval.request.silent).not.toBe(true);
    await approveNode(reapproval.request.requestId, approval, baseDir);
    await closeDatabase(database().path);
    expect(await migrateDesktop({}, baseDir)).toBe(0);
    expect((await getDevice(nodeId, baseDir))?.nodeSurface?.commands).toContain("desktop.stream");
  },
);

it("serializes with an already-loaded pairing writer before retiring desktop access", async () => {
  await approveDesktopNode();
  const loaded = createDeferred();
  const release = createDeferred();
  const writer = withDevices(baseDir, async (devices) => {
    loaded.resolve();
    await release.promise;
    const device = expectDefined(devices[nodeId], "pending writer's device");
    device.displayName = "Renamed while updating";
    return { value: undefined, persist: true };
  });
  await loaded.promise;
  const migration = migrateDesktop({}, baseDir);
  release.resolve();
  await writer;
  expect(await migration).toBe(1);
  const after = expectDefined(await getDevice(nodeId, baseDir), "migrated device");
  expect(after).toMatchObject({
    displayName: "Renamed while updating",
    nodeSurface: { commands: ["system.run"] },
  });
  expect(after.pendingNodeSurface).toBeUndefined();
});

it.each([undefined, { allow: [" desktop.stream "] }, { deny: ["desktop.stream"] }])(
  "records unchanged approvals for an empty startup or explicit policy %j",
  async (commands) => {
    if (!commands) {
      expect(await migrateDesktop({}, baseDir)).toBe(0);
      await closeDatabase(database().path);
    }
    const before = await approveDesktopNode();
    expect(
      await migrateDesktop(commands ? { gateway: { nodes: { commands } } } : {}, baseDir),
    ).toBe(0);
    expect(await getDevice(nodeId, baseDir)).toEqual(before);
    expect(await migrateDesktop({}, baseDir)).toBe(0);
    expect(await getDevice(nodeId, baseDir)).toEqual(before);
  },
);

it.each(["receipt failure", "malformed approval"] as const)(
  "preserves approval data without a completion receipt after %s",
  async (failure) => {
    const before = await approveDesktopNode();
    const { db } = database();
    const malformed = JSON.stringify({ ...before.nodeSurface, approvedAtMs: "invalid" });
    if (failure === "receipt failure") {
      db.exec(
        "CREATE TRIGGER reject_migration_receipt BEFORE INSERT ON migration_runs BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END",
      );
    } else {
      db.prepare("UPDATE device_pairing_paired SET node_surface_json = ? WHERE device_id = ?").run(
        malformed,
        nodeId,
      );
    }
    await expect(migrateDesktop({}, baseDir)).rejects.toThrow(
      failure === "receipt failure"
        ? "synthetic receipt failure"
        : "Cannot migrate malformed desktop approval",
    );
    if (failure === "receipt failure") {
      expect(await getDevice(nodeId, baseDir)).toEqual(before);
    } else {
      expect(
        db
          .prepare("SELECT node_surface_json FROM device_pairing_paired WHERE device_id = ?")
          .get(nodeId),
      ).toMatchObject({ node_surface_json: malformed });
    }
    expect(
      db
        .prepare("SELECT id FROM migration_runs WHERE id = ?")
        .get("node-desktop-stream-pairing-defaults-v1"),
    ).toBeUndefined();
    if (failure === "receipt failure") {
      db.exec("DROP TRIGGER reject_migration_receipt");
      expect(await migrateDesktop({}, baseDir)).toBe(1);
    }
  },
);

it.each(["devices", "nodes"])(
  "preserves opt-outs in later Doctor imports from %s",
  async (kind) => {
    await migrateDesktop({}, baseDir);
    const device = legacyNodeDevice(nodeId, {
      nodeSurface: { commands: desktop.commands, caps: ["screen"], ...timestamps },
    });
    if (kind === "nodes") {
      await seedNodeDevice(baseDir, nodeId);
    }
    const directory = path.join(baseDir, kind);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "paired.json"),
      JSON.stringify({ [nodeId]: kind === "devices" ? device : device.nodeSurface }),
    );
    await migrateDoctorPairingStores({ stateDir: baseDir, env: state.env, cfg: {} });
    expect((await getDevice(nodeId, baseDir))?.nodeSurface?.commands).toEqual(["system.run"]);
    expect(await migrateDesktop({}, baseDir)).toBe(0);
  },
);

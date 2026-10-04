import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { reconcileNodePairingOnConnect } from "../gateway/node-connect-reconcile.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { migrateLegacyDesktopStreamOptOuts } from "./device-pairing-node-desktop-migration.js";
import { approveNodePairing, listNodePairing, requestNodePairing } from "./device-pairing-node.js";
import { seedNodeDevice } from "./device-pairing-node.test-support.js";
import {
  getPairedDevice,
  resolveNodePairingGeneration,
  withPairedDeviceRecords,
  type PairedDevice,
} from "./device-pairing.js";
import { migrateDoctorPairingStores } from "./state-migrations.pairing.js";

const temporary = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const nodeId = "openclaw-macos";
let baseDir: string;

beforeEach(() => {
  baseDir = temporary.make("openclaw-desktop-approval-migration-");
});

function database() {
  return openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } });
}

async function approveDesktopNode() {
  await seedNodeDevice(baseDir, nodeId);
  const { request } = await requestNodePairing(
    {
      nodeId,
      platform: "macos",
      caps: ["screen", "system"],
      commands: ["desktop.stream", "system.run"],
    },
    baseDir,
  );
  await approveNodePairing(
    request.requestId,
    { callerScopes: ["operator.pairing", "operator.admin"] },
    baseDir,
  );
  return expectDefined(await getPairedDevice(nodeId, baseDir), "approved device");
}

describe("desktop approval upgrade", () => {
  it.each(["desktop", "unrelated"] as const)(
    "requires interactive desktop reapproval across reopen with %s pending state",
    async (pendingKind) => {
      const before = await approveDesktopNode();
      const declaredCommands = ["desktop.stream", "system.run", "system.which"];
      const pending = await requestNodePairing(
        {
          nodeId,
          platform: "macos",
          caps: ["screen", "system"],
          commands: pendingKind === "desktop" ? declaredCommands : ["system.run", "system.which"],
          silent: true,
        },
        baseDir,
      );
      // Seed the legacy hint directly: current requests keep upgrades interactive.
      await withPairedDeviceRecords(baseDir, (devices) => {
        const legacy = expectDefined(devices[nodeId]?.pendingNodeSurface, "legacy pending surface");
        legacy.silent = true;
        return { value: undefined, persist: true };
      });
      expect(await migrateLegacyDesktopStreamOptOuts({}, baseDir)).toBe(1);
      const after = expectDefined(await getPairedDevice(nodeId, baseDir), "migrated device");
      expect(after.nodeSurface?.commands).toEqual(["system.run"]);
      expect(after.nodeSurface?.caps).toEqual(before.nodeSurface?.caps);
      expect(after.tokens).toEqual(before.tokens);
      expect(after.roles).toEqual(before.roles);
      expect(resolveNodePairingGeneration(after)?.key).not.toBe(
        resolveNodePairingGeneration(before)?.key,
      );
      expect(after.pendingNodeSurface).toMatchObject({
        requestId: pending.request.requestId,
        silent: pendingKind === "unrelated",
        commands: pending.request.commands,
      });

      await closeOpenClawStateDatabaseByPathAsync(database().path);
      const pairedNode = expectDefined((await listNodePairing(baseDir)).paired[0], "paired node");
      const reconciled = await reconcileNodePairingOnConnect({
        cfg: {},
        connectParams: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "openclaw-macos",
            version: "test",
            platform: "macos",
            deviceFamily: "Mac",
            mode: "node",
          },
          caps: ["screen", "system"],
          commands: declaredCommands,
        },
        pairedNode,
        initialSurfaceSilent: true,
        requestPairing: (input) => requestNodePairing(input, baseDir),
      });
      expect(reconciled.effectiveCommands).toEqual(["system.run"]);
      const reapproval = expectDefined(reconciled.pendingPairing, "interactive reapproval");
      expect(reapproval.request.silent).not.toBe(true);
      await approveNodePairing(
        reapproval.request.requestId,
        { callerScopes: ["operator.pairing", "operator.admin"] },
        baseDir,
      );
      await closeOpenClawStateDatabaseByPathAsync(database().path);
      expect(await migrateLegacyDesktopStreamOptOuts({}, baseDir)).toBe(0);
      expect((await getPairedDevice(nodeId, baseDir))?.nodeSurface?.commands).toContain(
        "desktop.stream",
      );
    },
  );

  it("serializes with an already-loaded pairing writer before retiring desktop access", async () => {
    await approveDesktopNode();
    const loaded = createDeferred();
    const release = createDeferred();
    const writer = withPairedDeviceRecords(baseDir, async (devices) => {
      loaded.resolve();
      await release.promise;
      const device = expectDefined(devices[nodeId], "pending writer's device");
      device.displayName = "Renamed while updating";
      return { value: undefined, persist: true };
    });
    await loaded.promise;
    const migration = migrateLegacyDesktopStreamOptOuts({}, baseDir);
    release.resolve();
    await writer;
    expect(await migration).toBe(1);
    const after = expectDefined(await getPairedDevice(nodeId, baseDir), "migrated device");
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
        expect(await migrateLegacyDesktopStreamOptOuts({}, baseDir)).toBe(0);
        await closeOpenClawStateDatabaseByPathAsync(database().path);
      }
      const before = await approveDesktopNode();
      expect(
        await migrateLegacyDesktopStreamOptOuts(
          commands ? { gateway: { nodes: { commands } } } : {},
          baseDir,
        ),
      ).toBe(0);
      expect(await getPairedDevice(nodeId, baseDir)).toEqual(before);
      expect(await migrateLegacyDesktopStreamOptOuts({}, baseDir)).toBe(0);
      expect(await getPairedDevice(nodeId, baseDir)).toEqual(before);
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
        db.prepare(
          "UPDATE device_pairing_paired SET node_surface_json = ? WHERE device_id = ?",
        ).run(malformed, nodeId);
      }
      await expect(migrateLegacyDesktopStreamOptOuts({}, baseDir)).rejects.toThrow(
        failure === "receipt failure"
          ? "synthetic receipt failure"
          : "Cannot migrate malformed desktop approval",
      );
      if (failure === "receipt failure") {
        expect(await getPairedDevice(nodeId, baseDir)).toEqual(before);
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
        expect(await migrateLegacyDesktopStreamOptOuts({}, baseDir)).toBe(1);
      }
    },
  );

  it.each(["devices", "nodes"])(
    "preserves opt-outs in later Doctor imports from %s",
    async (kind) => {
      await migrateLegacyDesktopStreamOptOuts({}, baseDir);
      const device: PairedDevice = {
        deviceId: nodeId,
        publicKey: "synthetic-public-key",
        role: "node",
        roles: ["node"],
        tokens: { node: { role: "node", token: "synthetic-token", scopes: [], createdAtMs: 1 } },
        createdAtMs: 1,
        approvedAtMs: 1,
        nodeSurface: {
          commands: ["desktop.stream", "system.run"],
          caps: ["screen"],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      };
      if (kind === "nodes") {
        await seedNodeDevice(baseDir, nodeId);
      }
      const directory = path.join(baseDir, kind);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, "paired.json"),
        JSON.stringify({ [nodeId]: kind === "devices" ? device : device.nodeSurface }),
      );
      await migrateDoctorPairingStores({
        stateDir: baseDir,
        env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
        cfg: {},
      });
      expect((await getPairedDevice(nodeId, baseDir))?.nodeSurface?.commands).toEqual([
        "system.run",
      ]);
      expect(await migrateLegacyDesktopStreamOptOuts({}, baseDir)).toBe(0);
    },
  );
});

import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveGatewayLockDir } from "../config/paths.js";
import {
  acquireGatewayStateOwner,
  tryAcquireGatewayStateOwner,
} from "../infra/gateway-state-owner.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { migrateLegacySkillWorkshopProposals } from "./doctor-skill-workshop-sqlite.js";

it("respects another migration owner even when the state database is already open", async () => {
  await withOpenClawTestState({ label: "workshop-migration-owner" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const otherOwner = acquireGatewayStateOwner({ databasePath: database.path });
    try {
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: state.env }),
      ).rejects.toThrow("OpenClaw state database is busy at");
    } finally {
      otherOwner?.release();
    }
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: state.env }),
    ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
  });
});

it("preserves Doctor's outer ownership after migration failure until cleanup finishes", async () => {
  await withOpenClawTestState({ label: "workshop-migration-release" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const outer = acquireGatewayStateOwner({ databasePath: database.path });
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: outer.assertCurrent,
      assertDatabaseAccess: outer.assertDatabaseAccess,
    });
    const backupRoot = path.join(state.stateDir, "skill-workshop", "collection-backups");
    await fs.mkdir(backupRoot, { recursive: true });
    const readDirectory = vi
      .spyOn(fs, "readdir")
      .mockRejectedValueOnce(new Error("backup directory unavailable"));
    try {
      await expect(
        maintenance.run(() => migrateLegacySkillWorkshopProposals({ config: {}, env: state.env })),
      ).rejects.toThrow("backup directory unavailable");
      expect(tryAcquireGatewayStateOwner(database.path)).toBeNull();
    } finally {
      readDirectory.mockRestore();
      await maintenance.close();
      outer.release();
    }
    const nextOwner = tryAcquireGatewayStateOwner(database.path);
    expect(nextOwner).not.toBeNull();
    nextOwner?.release();
  });
});

it("preserves legacy Workshop files while a published Gateway marker owns the state", async () => {
  await withOpenClawTestState({ label: "workshop-legacy-gateway" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const manifest = await state.writeText("skill-workshop/proposals.json", "[]\n");
    const lockPath = path.join(resolveGatewayLockDir(state.stateDir), "gateway.state.lock");
    const startTime = getFileLockProcessStartTime(process.pid);
    expect(startTime).not.toBeNull();
    const marker = JSON.stringify({
      pid: process.pid,
      startTime,
      createdAt: new Date().toISOString(),
      configPath: state.configPath,
    });
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, marker);
    try {
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: state.env }),
      ).rejects.toThrow("OpenClaw state database is busy at");
      expect(await fs.readFile(manifest, "utf8")).toBe("[]\n");
      expect(await fs.readFile(lockPath, "utf8")).toBe(marker);
      const releasedOwner = tryAcquireGatewayStateOwner(database.path);
      expect(releasedOwner).not.toBeNull();
      releasedOwner?.release();
    } finally {
      await fs.rm(lockPath);
    }
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: state.env }),
    ).resolves.toMatchObject({
      changes: ["Removed the empty legacy Skill Workshop proposal index."],
      warnings: [],
    });
    await expect(fs.stat(manifest)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

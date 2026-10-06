import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  withFleetCellOperationLease,
  deleteFleetCell,
  getFleetCell,
  listFleetCells,
  reserveFleetCell,
  updateFleetCellImage,
} from "./registry.js";

type ReserveFleetCellParams = Parameters<typeof reserveFleetCell>[1];

describe("fleet cell registry", () => {
  let root: string | undefined;
  let env: NodeJS.ProcessEnv;

  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-fleet-registry-" });

  beforeEach(async () => {
    root = await tempRoot.setup();
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await tempRoot.cleanup();
    root = undefined;
  });

  function params(tenantId: string, requestedPort?: number): ReserveFleetCellParams {
    if (!root) {
      throw new Error("test root not initialized");
    }
    return {
      tenantId,
      createdAtMs: 1,
      image: "ghcr.io/openclaw/openclaw:latest",
      runtime: "docker",
      containerName: `openclaw-cell-${tenantId}`,
      dataDir: path.join(root, "fleet", "cells", tenantId),
      ...(requestedPort === undefined ? {} : { requestedPort }),
    };
  }

  it("returns empty reads without creating state on a fresh install", async () => {
    if (!root) {
      throw new Error("test root not initialized");
    }
    const databasePath = path.join(root, "state", "openclaw.sqlite");

    expect(await listFleetCells(env)).toEqual([]);
    expect(await getFleetCell(env, "missing")).toBeUndefined();
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("persists, orders, updates, and deletes cells", async () => {
    const zulu = await reserveFleetCell(env, {
      ...params("zulu", 19_250),
      createdAtMs: 20,
      runtime: "podman",
    });
    const alpha = await reserveFleetCell(env, {
      ...params("alpha"),
      createdAtMs: 10,
    });

    expect(alpha.hostPort).toBe(19_100);
    expect(zulu.hostPort).toBe(19_250);
    expect((await listFleetCells(env)).map((cell) => cell.tenantId)).toEqual(["alpha", "zulu"]);
    expect(await getFleetCell(env, "zulu")).toEqual(zulu);

    await updateFleetCellImage(env, "zulu", "ghcr.io/openclaw/openclaw:v2");
    expect((await getFleetCell(env, "zulu"))?.image).toBe("ghcr.io/openclaw/openclaw:v2");

    await deleteFleetCell(env, "alpha");
    expect(await getFleetCell(env, "alpha")).toBeUndefined();
  });

  it("rejects duplicate tenant ids without replacing the row", async () => {
    const original = await reserveFleetCell(env, params("alpha", 19_300));

    await expect(
      reserveFleetCell(env, {
        ...params("alpha", 19_301),
        image: "ghcr.io/openclaw/openclaw:other",
      }),
    ).rejects.toThrow("Fleet cell already exists: alpha");
    expect(await getFleetCell(env, "alpha")).toEqual(original);
  });

  it("allocates the first free port and rejects explicit collisions", async () => {
    expect((await reserveFleetCell(env, params("alpha"))).hostPort).toBe(19_100);
    expect((await reserveFleetCell(env, params("beta"))).hostPort).toBe(19_101);

    await expect(reserveFleetCell(env, params("gamma", 19_100))).rejects.toThrow(/19100/);
    expect(await getFleetCell(env, "gamma")).toBeUndefined();
    expect((await reserveFleetCell(env, params("delta", 20_000))).hostPort).toBe(20_000);
  });

  it("serializes tenant mutations with renewable expiring leases", async () => {
    await withFleetCellOperationLease(
      { env, tenantId: "alpha", operation: "upgrade", owner: "first", nowMs: 1_000 },
      async (first) => {
        await expect(
          withFleetCellOperationLease(
            { env, tenantId: "alpha", operation: "rm", owner: "second", nowMs: 1_001 },
            async () => {},
          ),
        ).rejects.toThrow(/fleet upgrade.*already running/iu);
        await first.heartbeat(200_000);
        await expect(
          withFleetCellOperationLease(
            { env, tenantId: "alpha", operation: "rm", owner: "second", nowMs: 400_000 },
            async () => {},
          ),
        ).rejects.toThrow(/already running/iu);
        await first.release();
        await withFleetCellOperationLease(
          { env, tenantId: "alpha", operation: "rm", owner: "second", nowMs: 400_001 },
          async (second) => {
            await second.release();
          },
        );
      },
    );
  });

  it("fences an expired owner from its replacement lease", async () => {
    await withFleetCellOperationLease(
      { env, tenantId: "alpha", operation: "upgrade", owner: "first", nowMs: 1_000 },
      async (first) => {
        await expect(reserveFleetCell(env, params("alpha"))).rejects.toThrow(/lease was lost/iu);
        expect(await getFleetCell(env, "alpha")).toBeUndefined();
        await withFleetCellOperationLease(
          { env, tenantId: "alpha", operation: "rm", owner: "successor", nowMs: 301_000 },
          async (successor) => {
            await expect(first.heartbeat(301_001)).rejects.toThrow(/lease was lost/iu);
            await first.release();
            await expect(
              withFleetCellOperationLease(
                { env, tenantId: "alpha", operation: "create", owner: "third", nowMs: 301_002 },
                async () => {},
              ),
            ).rejects.toThrow(/fleet rm.*already running/iu);
            await successor.release();
          },
        );
      },
    );
  });

  it("fails image updates when the cell row disappeared", async () => {
    await expect(updateFleetCellImage(env, "missing", "image:v2")).rejects.toThrow(/disappeared/iu);
  });
});

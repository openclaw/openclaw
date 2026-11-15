import fs from "node:fs";
import { isMainThread } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

it("prepares cold Gateway read custody asynchronously and reuses warm admission", async () => {
  expect(isMainThread).toBe(true);
  await withOpenClawTestState({ label: "state-read-gateway-custody" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const owner = acquireGatewayStateOwner({
      databasePath: database.path,
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: state.configPath,
        role: "gateway",
        processNamespace: readGatewayLockProcessNamespace(),
      },
    });
    const realpath = vi.spyOn(fs.realpathSync, "native");
    const resolve = fs.promises.realpath.bind(fs.promises);
    const gatewayLookups: number[] = [];
    const asyncRealpath = vi.spyOn(fs.promises, "realpath").mockImplementation((...args) => {
      if (new Error().stack?.includes("gateway-state-owner")) {
        gatewayLookups.push(1);
      }
      return resolve(...args);
    });
    try {
      for (const expectedLookups of [1, 0, 0]) {
        realpath.mockClear();
        gatewayLookups.length = 0;
        await expect(
          executeExistingOpenClawStateRead({ env: state.env }, { type: "backup.runs" }),
        ).resolves.toMatchObject({ ok: true, type: "backup.runs", runs: [] });
        expect(realpath.mock.calls.length).toBe(0);
        expect(gatewayLookups).toHaveLength(expectedLookups);
      }
    } finally {
      realpath.mockRestore();
      asyncRealpath.mockRestore();
      await closeOpenClawStateDatabaseAsync();
      owner.release();
    }
  });
});

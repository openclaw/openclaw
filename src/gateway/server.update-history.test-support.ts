import { existsSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { createRetainedUpdateRecovery } from "../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import {
  beginGatewayRestartSignalAdmission,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

export function registerGatewayUpdateHistoryTests(
  getPort: () => number,
  readonlyPreparation: {
    prepared: Array<{ pathname: string; location?: string; progressed: boolean }>;
    turns: Promise<void>[];
  },
) {
  const connect = () =>
    connectGatewayClient({
      url: `ws://127.0.0.1:${getPort()}`,
      token: "secret",
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientVersion: "1.0.0",
      scopes: ["operator.admin"],
    });
  const atAge = (minutes: number) =>
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - minutes * 60_000);
  test.each(["signal", "service-stop"] as const)(
    "reads progress on an existing authenticated connection during %s",
    async (phase) => {
      const client = await connect();
      try {
        const clock = atAge(25 * 60);
        const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
        clock.mockRestore();
        if (phase === "signal") {
          expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
        } else {
          markGatewayRestartDraining("stop (SIGTERM)");
        }
        const read = client.request("update.runs.get", { runId: run.runId });
        if (phase === "signal") {
          await expect(read).rejects.toThrow("unavailable during gateway restart");
        } else {
          expect(await read).toEqual({ run });
        }
        expect(getUpdateRun(run.runId)).toEqual(run);
      } finally {
        resetGatewayWorkAdmission();
        await client.stopAndWait();
      }
    },
  );

  test.each(["fresh", "expired", "retained"] as const)(
    "keeps authenticated update history responsive (%s)",
    async (shape) => {
      const client = await connect();
      try {
        const clock = atAge(shape === "fresh" ? 0 : 25 * 60);
        const run = createUpdateRun({ trigger: "api" });
        if (shape === "retained") {
          const from = {
            root: process.env.OPENCLAW_STATE_DIR ?? "/fixture",
            nodePath: process.execPath,
            version: "2026.9.2",
            buildId: null,
          };
          createRetainedUpdateRecovery({
            runId: run.runId,
            from,
            to: { ...from, version: "2026.9.3" },
          });
        }
        clock.mockRestore();
        const databasePath = openOpenClawStateDatabase().path;
        const methods =
          shape === "fresh" ? ["update.runs.get", "update.runs.list"] : ["update.runs.get"];
        for (const method of methods) {
          // Exercise expiry cold first, before a warm read could reconcile the row.
          for (const cache of ["closed", "warm"] as const) {
            openOpenClawStateDatabase();
            if (cache === "closed") {
              expect(await closeOpenClawStateDatabaseByPathAsync(databasePath)).toBe(true);
            }
            expect(isOpenClawStateDatabaseOpen(databasePath)).toBe(cache === "warm");
            const before = readonlyPreparation.prepared.length;
            const get = method === "update.runs.get";
            const result = await client.request(method, get ? { runId: run.runId } : { limit: 1 });
            await Promise.all(readonlyPreparation.turns);
            const expired = { runId: run.runId, status: "failed", reason: "legacy-driver-expired" };
            const expected = shape === "expired" ? expect.objectContaining(expired) : run;
            expect(result).toEqual(get ? { run: expected } : { runs: [expected] });
            const prepared = readonlyPreparation.prepared
              .slice(before)
              .filter((entry) => entry.pathname === databasePath);
            expect(prepared.map(({ progressed }) => progressed)).toEqual(
              cache === "warm" ? [] : [true],
            );
            if (cache === "closed") {
              expect(prepared[0]?.location).toBeDefined();
              expect(existsSync(prepared[0]!.location!)).toBe(false);
            }
          }
        }
      } finally {
        await client.stopAndWait();
      }
    },
  );
}

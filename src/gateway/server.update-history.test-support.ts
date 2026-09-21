import { existsSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { createRetainedUpdateRecovery } from "../infra/update-retained-recovery.test-support.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
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
  describe("gateway update history", () => {
    test.each(["fresh", "expired", "retained"] as const)(
      "keeps authenticated update history responsive (%s)",
      async (shape) => {
        const port = getPort();
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: "secret",
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          clientVersion: "1.0.0",
          scopes: ["operator.admin"],
        });
        try {
          const clock = vi
            .spyOn(Date, "now")
            .mockReturnValue(Date.now() - (shape === "fresh" ? 0 : 25 * 60 * 60_000));
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
                expect(closeOpenClawStateDatabaseByPath(databasePath)).toBe(true);
              }
              expect(isOpenClawStateDatabaseOpen(databasePath)).toBe(cache === "warm");
              const before = readonlyPreparation.prepared.length;
              const result = await client.request(
                method,
                method === "update.runs.get" ? { runId: run.runId } : { limit: 1 },
              );
              await Promise.all(readonlyPreparation.turns);
              const expected =
                shape === "expired"
                  ? expect.objectContaining({
                      runId: run.runId,
                      status: "failed",
                      reason: "legacy-driver-expired",
                    })
                  : run;
              expect(result).toEqual(
                method === "update.runs.get" ? { run: expected } : { runs: [expected] },
              );
              const prepared = readonlyPreparation.prepared
                .slice(before)
                .filter((entry) => entry.pathname === databasePath);
              expect(
                prepared.every((entry) => entry.progressed),
                "the Gateway isolate must progress during every cold-history snapshot",
              ).toBe(true);
              if (cache === "warm") {
                expect(prepared).toEqual([]);
              } else {
                expect(prepared).toHaveLength(1);
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
  });
}

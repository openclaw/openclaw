import { stripVTControlCharacters } from "node:util";
import { expect } from "vitest";
import type { GatewayClient } from "./client.js";

/** Only complete startup records can prove cumulative pool reuse across Gateway boots. */
function readPostgresBridgeStartupHistory(logs: string) {
  return [
    ...stripVTControlCharacters(logs).matchAll(/worker startup state: (\{[^\r\n]*\})\r?\n/gu),
  ].map((match) => {
    const snapshot: {
      workerLifecycle: Array<{
        script: string;
        started: number;
        retired: Array<{ reason: string; count: number }>;
      }>;
    } = JSON.parse(match[1]!);
    return snapshot.workerLifecycle.filter(({ script }) => script === "bridge.worker.js");
  });
}

export async function observePostgresPoolReuse(gateway: GatewayClient, readLogs: () => string) {
  const readBridgeStarts = () => readPostgresBridgeStartupHistory(readLogs());
  const census = { postgresBridgeCount: 4, postgresPoolSelfRootCount: 0 };
  const bridge = [{ script: "bridge.worker.js", started: 4, retired: [] }];
  await expect(gateway.request("diagnostics.lanes", {})).resolves.toMatchObject(census);
  await expect.poll(readBridgeStarts).toEqual([bridge]);
  return {
    expectBeforeRestart() {
      expect(readBridgeStarts()).toEqual([bridge]);
    },
    async expectAfterRestart(restarted: GatewayClient) {
      // Live count alone would also pass if all four services had been replaced.
      await expect.poll(readBridgeStarts).toEqual([bridge, bridge]);
      await expect(restarted.request("diagnostics.lanes", {})).resolves.toMatchObject(census);
    },
  };
}

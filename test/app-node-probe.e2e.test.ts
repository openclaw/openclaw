import { afterAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../src/gateway/client.js";
import {
  type GatewayInstance,
  connectNode,
  spawnGatewayInstance,
  stopGatewayInstance,
  waitForNodeStatus,
} from "./helpers/gateway-e2e-harness.js";

const E2E_TIMEOUT_MS = 30_000;

describe("gateway app node probe", () => {
  const instances: GatewayInstance[] = [];
  const nodeClients: GatewayClient[] = [];

  afterAll(async () => {
    for (const client of nodeClients) {
      client.stop();
    }
    for (const inst of instances) {
      await stopGatewayInstance(inst);
    }
  });

  it(
    "does not timeout probing an app node",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const gw = await spawnGatewayInstance("app-probe-test");
      instances.push(gw);

      // Connect an app node with no declared commands: gateway policy must not
      // assign system.run to app nodes, so probing should be skipped entirely.
      const startTime = Date.now();
      const node = await connectNode(gw, "macos-app", {
        platform: "macos",
        deviceFamily: "Mac",
        mode: "node",
        clientId: "openclaw-macos",
        commands: [],
      });
      nodeClients.push(node.client);

      // waitForNodeStatus returns the matched node entry from node.list once
      // connected and paired — use it directly to verify commands.
      const nodeStatus = await waitForNodeStatus(gw, node.nodeId);

      const duration = Date.now() - startTime;

      // Without probing suppression this would take ~10–15 s per timed-out
      // probe. With the fix it should complete well within 5 s.
      expect(duration).toBeLessThan(5000);

      // App nodes must not have system.run assigned by the gateway policy.
      expect((nodeStatus as any).commands ?? []).not.toContain("system.run");
    },
  );
});

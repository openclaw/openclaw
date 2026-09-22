import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import {
  createNodeRegistryRuntime,
  updateNodeRunnerInventory,
  waitForNodeWorkerSupervisor,
} from "./node-registry-private.js";
import { NodeRegistry } from "./node-registry.js";
import { createWorkerSupervisorNodeClient } from "./server-methods/nodes.runner-inventory.test-support.js";

describe("worker supervisor availability admission", () => {
  it.each(["reconnect", "reconnect-during-read", "cancelled", "incompatible"] as const)(
    "waits for a current worker supervisor proof: %s",
    async (scenario) => {
      const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
        () => new NodeRegistry(),
      );
      const controller = new AbortController();
      const firstRead = createDeferred();
      const connect = () => {
        nodeRegistry.register(createWorkerSupervisorNodeClient("reconnected"), {
          pairingIdentity: "identity-a",
          pairingGeneration: "generation-a",
        });
        updateNodeRunnerInventory({
          registry: nodeRegistry,
          nodeId: "node-1",
          connId: "reconnected",
          declaration:
            scenario === "incompatible"
              ? { protocolFeatures: ["node-worker-supervisor-v5"] }
              : {
                  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
                  workerHost: { enabled: true, capacity: { total: 1, available: 1 } },
                },
        });
      };
      vi.spyOn(nodeWorkerSupervisorTransport, "getCurrentNode").mockImplementationOnce(async () => {
        if (scenario === "reconnect-during-read") {
          connect();
        }
        firstRead.resolve();
        return undefined;
      });
      const waiting = waitForNodeWorkerSupervisor(nodeRegistry, "node-1", {
        signal: controller.signal,
        assertCurrent: () => {},
      });
      const result = waiting.then(
        () => "ready",
        (error: unknown) => error,
      );
      await firstRead.promise;
      if (scenario === "cancelled") {
        controller.abort(new Error("turn stopped"));
      } else if (scenario !== "reconnect-during-read") {
        connect();
      }
      if (scenario === "cancelled" || scenario === "incompatible") {
        expect(await result).toBeInstanceOf(Error);
      } else {
        expect(await result).toBe("ready");
        expect(nodeWorkerSupervisorTransport.hasCurrentRunner("node-1")).toBe(true);
      }
    },
  );
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import {
  createNodeRegistryRuntime,
  updateNodeRunnerInventory,
  waitForNodeWorkerSupervisor,
} from "./node-registry-private.js";
import { NodeRegistry } from "./node-registry.js";
import { createWorkerSupervisorNodeClient } from "./server-methods/nodes.runner-inventory.test-support.js";

afterEach(() => vi.useRealTimers());

describe("worker supervisor availability admission", () => {
  it.each([
    { reader: "async", scenario: "current" },
    { reader: "published", scenario: "current" },
    { reader: "async", scenario: "revoked" },
    { reader: "async", scenario: "cancelled" },
    { reader: "async", scenario: "stale" },
  ] as const)(
    "wakes after a transient $reader pairing read recovers without an inventory change: $scenario",
    async ({ reader, scenario }) => {
      const pairing = { identity: "identity-a", generation: "generation-a" };
      const resolveCurrentPairingState = vi.fn(async () => pairing);
      const isPairingStateCurrent = vi.fn(() => true);
      const { nodeRegistry, nodeWorkerSupervisorTransport: transport } = createNodeRegistryRuntime(
        () => new NodeRegistry({ resolveCurrentPairingState, isPairingStateCurrent }),
      );
      nodeRegistry.register(createWorkerSupervisorNodeClient(), {
        pairingIdentity: pairing.identity,
        pairingGeneration: pairing.generation,
      });
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        },
      });
      if (reader === "async") {
        resolveCurrentPairingState.mockRejectedValueOnce(
          new Error("pairing reader temporarily unavailable"),
        );
      } else {
        isPairingStateCurrent.mockImplementationOnce(() => {
          throw new Error("pairing publication temporarily unavailable");
        });
      }
      const controller = new AbortController();
      let current = true;
      let outcome: "pending" | "ready" | "refused" = "pending";
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const waiting = transport.waitForCurrentNode!("node-1", {
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("turn authority revoked");
          }
        },
      }).then(
        () => {
          outcome = "ready";
        },
        () => {
          outcome = "refused";
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("pending");
        if (scenario === "revoked") {
          current = false;
        }
        if (scenario === "cancelled") {
          controller.abort(new Error("turn stopped"));
        }
        if (scenario === "stale") {
          pairing.generation = "generation-b";
        }
        // No catalog read or runner event: admission itself must recover.
        await vi.advanceTimersByTimeAsync(249);
        expect(outcome).toBe(scenario === "cancelled" ? "refused" : "pending");
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome).toBe(
          scenario === "current" ? "ready" : scenario === "stale" ? "pending" : "refused",
        );
      } finally {
        controller.abort(new Error("fixture complete"));
        await waiting;
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );
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

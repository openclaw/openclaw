import { afterEach, expect, it, vi } from "vitest";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

const createBroker = useSpawnBrokerTestFixture(afterEach);

it("builds the lazy hook dispatcher under its transport owner's broker", async () => {
  const owner = await createBroker();
  const caller = await createBroker();
  const runtime = await runWithSpawnBroker(owner, () => createGatewayRuntimeStateForTest());
  const hooks = await import("./server/hooks.js");
  const reachedConstruction = new Error("hook constructor reached");
  let observedBroker: unknown = "not-built";
  const createDispatcher = vi.spyOn(hooks, "createGatewayHookDispatcher").mockImplementation(() => {
    observedBroker = getSpawnBroker();
    throw reachedConstruction;
  });
  try {
    await expect(
      runWithSpawnBroker(caller, () =>
        runtime.dispatchHookAgentTurn("synthetic-hook", {
          name: "Broker ownership",
          agentId: "main",
          sessionKey: "agent:main:hook-broker",
          message: "synthetic",
          externalContentSource: "email",
          deliver: false,
        }),
      ),
    ).rejects.toBe(reachedConstruction);
    expect(observedBroker === owner).toBe(true);
  } finally {
    createDispatcher.mockRestore();
    await new Promise<void>((resolve) => {
      runtime.wss.close(() => resolve());
    });
  }
});

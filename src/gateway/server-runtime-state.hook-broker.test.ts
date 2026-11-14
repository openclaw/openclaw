import { afterEach, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

const createBroker = useSpawnBrokerTestFixture(afterEach);

it("builds the lazy hook dispatcher under its transport owner's broker", async () => {
  const owner = await createBroker();
  const caller = await createBroker();
  let currentRegistry = createEmptyPluginRegistry();
  const runtime = await runWithSpawnBroker(owner, () =>
    createGatewayRuntimeStateForTest(currentRegistry, {
      getPluginRouteRegistry: () => currentRegistry,
    }),
  );
  const hooks = await import("./server/hooks.js");
  const reachedConstruction = new Error("hook constructor reached");
  let observedBroker: unknown = "not-built";
  let resolveRegistry: (() => unknown) | undefined;
  const createDispatcher = vi
    .spyOn(hooks, "createGatewayHookDispatcher")
    .mockImplementation((params) => {
      resolveRegistry = params.resolvePluginRegistry;
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
    expect(resolveRegistry?.()).toBe(currentRegistry);
    currentRegistry = createEmptyPluginRegistry();
    expect(resolveRegistry?.()).toBe(currentRegistry);
  } finally {
    createDispatcher.mockRestore();
    await new Promise<void>((resolve) => {
      runtime.wss.close(() => resolve());
    });
  }
});

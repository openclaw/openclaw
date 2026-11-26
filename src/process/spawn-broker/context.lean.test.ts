import { afterEach, expect, it, vi } from "vitest";
import { gatewaySpawnBrokerState } from "./context-state.js";
import { startGatewaySpawnBroker } from "./context.js";
import type { SpawnBrokerHost } from "./host.js";

const createSpawnBrokerHost = vi.hoisted(() => vi.fn());
vi.mock("./host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./host.js")>()),
  createSpawnBrokerHost,
}));

afterEach(() => {
  gatewaySpawnBrokerState.host = undefined;
  gatewaySpawnBrokerState.startupDisabled = false;
  createSpawnBrokerHost.mockReset();
});

it("keeps a lean Gateway on direct spawning without disabling the broker for later starts", async () => {
  const onStartupFailure = vi.fn();
  await expect(
    startGatewaySpawnBroker({ profile: "lean", onReady: vi.fn(), onStartupFailure }),
  ).resolves.toBeUndefined();
  expect(createSpawnBrokerHost).not.toHaveBeenCalled();
  expect(onStartupFailure).not.toHaveBeenCalled();
  expect(gatewaySpawnBrokerState).toEqual({ host: undefined, startupDisabled: false });
});

it.skipIf(process.constrainedMemory() > 0 && process.constrainedMemory() <= 1024 ** 3)(
  "starts the broker for a standard Gateway",
  async () => {
    const host = {
      entryPath: "/broker/worker.js",
      ready: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as SpawnBrokerHost;
    createSpawnBrokerHost.mockReturnValue(host);
    await expect(
      startGatewaySpawnBroker({ profile: "standard", onReady: vi.fn(), onStartupFailure: vi.fn() }),
    ).resolves.toBe(host);
    expect(gatewaySpawnBrokerState.host).toBe(host);
  },
);

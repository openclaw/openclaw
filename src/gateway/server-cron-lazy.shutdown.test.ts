import { expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createLazyGatewayCronState } from "./server-cron-lazy.js";

const { importStarted, releaseImport, buildGatewayCronService } = vi.hoisted(() => ({
  importStarted: Promise.withResolvers<void>(),
  releaseImport: Promise.withResolvers<void>(),
  buildGatewayCronService: vi.fn(),
}));

// mock-isolation: Hold module loading before any scheduler resources can be created.
vi.mock("./server-cron.js", async () => {
  importStarted.resolve();
  await releaseImport.promise;
  return { buildGatewayCronService };
});

it("closes without joining an unbuilt cron import and refuses its late construction", async () => {
  const lazy = createLazyGatewayCronState({
    storePath: "/synthetic/cron.json",
    scheduler: createTestGatewayScheduler(),
    cfg: {},
    deps: {} as CliDeps,
    broadcast: vi.fn(),
  });
  const starting = lazy.cron.start();
  void starting.catch(() => {});
  await importStarted.promise;
  let closed = false;
  const closing = lazy.cron.stopAndDrain!().then(() => {
    closed = true;
  });
  try {
    await expect.poll(() => closed, { timeout: 500 }).toBe(true);
  } finally {
    releaseImport.resolve();
    await starting.catch(() => {});
    await closing;
  }
  await expect(starting).rejects.toThrow("Cron service is closed");
  await expect(lazy.cron.status()).rejects.toThrow("Cron service is closed");
  expect(buildGatewayCronService).not.toHaveBeenCalled();
});

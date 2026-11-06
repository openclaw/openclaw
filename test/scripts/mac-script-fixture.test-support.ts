import { availableParallelism } from "node:os";
import { it, vi } from "vitest";
import { createCommandFixture, type CommandFixture } from "../helpers/command-fixture.js";

export type MacScriptFixture = CommandFixture;

export function createMacScriptTest() {
  const test = it.extend<{ mac: MacScriptFixture }>({
    mac: async ({ signal, onTestFinished }, use) => {
      // Keep the Mac script suite's strict leader-exit verification.
      await use(createCommandFixture({ signal, onTestFinished }, "tree"));
    },
  });
  // Resolve ownership before runTest: onTestFinished aborts outstanding commands
  // before whole-body cleanup waits for their finally blocks and removes inputs.
  test.aroundEach(async (runTest, { mac }) => {
    try {
      await runTest();
    } finally {
      await mac.lifetime.cleanup();
    }
  });
  // Keep outer suites sequential: this per-group cap is applied after Vitest's
  // file-wide limiter is created, so concurrent suites could each admit the full cap.
  test.beforeAll(() => {
    vi.setConfig({ maxConcurrency: Math.min(3, availableParallelism()) });
    return () => vi.resetConfig();
  });
  return test;
}

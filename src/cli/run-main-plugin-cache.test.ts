import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cache: { kind: "operation" as const },
  retirePluginCache: vi.fn(async () => ({ cleanupCount: 0, failures: [] })),
}));

// mock-isolation: assert the CLI owner passes terminal settlement without loading real plugin state.
vi.mock("../plugins/plugin-cache.js", () => ({
  createPluginCache: () => mocks.cache,
  retirePluginCache: mocks.retirePluginCache,
  withPluginCache: (_cache: unknown, run: () => unknown) => run(),
}));

// mock-isolation: this unit test does not exercise capture scheduling or its global owner.
vi.mock("../plugins/plugin-source-capture-context.js", () => ({
  pluginSourceCaptureMaintenance: {
    run: (_owner: unknown, run: () => unknown) => run(),
  },
}));

// mock-isolation: emulate only resource adoption and release without process-global cleanup hooks.
vi.mock("./runtime-cleanup-scope.js", () => ({
  withCliCommandCleanup: async (
    _gatewayRun: boolean,
    run: (cleanup: {
      scheduler: object;
      pluginResources: {
        adopt(resource: { release: () => Promise<void> }): void;
        run<T>(operation: () => T | Promise<T>): Promise<T>;
      };
    }) => unknown,
  ) => {
    const adopted: Array<{ release: () => Promise<void> }> = [];
    const result = await run({
      scheduler: {},
      pluginResources: {
        adopt: (resource) => adopted.push(resource),
        run: async (operation) => operation(),
      },
    });
    await Promise.all(adopted.map((resource) => resource.release()));
    return result;
  },
}));

import { withCliPluginInvocation } from "./run-main-plugin-cache.js";

beforeEach(() => {
  mocks.retirePluginCache.mockClear();
});

it("joins timed-out plugin settlement before a one-shot CLI inventory releases", async () => {
  await withCliPluginInvocation(false, async () => undefined);

  expect(mocks.retirePluginCache).toHaveBeenCalledWith(mocks.cache, undefined, {
    waitForSettlement: true,
  });
});

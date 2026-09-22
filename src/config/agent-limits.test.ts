// Verifies CPU-derived and configured agent runtime limits.
import os from "node:os";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

async function importFreshAgentLimits(scope: string): Promise<typeof import("./agent-limits.js")> {
  return importFreshModule(import.meta.url, `./agent-limits.js?scope=${scope}`);
}

describe("resolveAgentMaxConcurrent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { availableParallelism: 1, expected: 8 },
    { availableParallelism: 2, expected: 8 },
    { availableParallelism: 8, expected: 32 },
    { availableParallelism: 12, expected: 48 },
    { availableParallelism: 48, expected: 192 },
  ])(
    "derives the default from $availableParallelism available CPUs",
    async ({ availableParallelism, expected }) => {
      const availableParallelismSpy = vi
        .spyOn(os, "availableParallelism")
        .mockReturnValue(availableParallelism);
      const runtime = await importFreshAgentLimits(`parallelism-${availableParallelism}`);

      expect(runtime.resolveAgentMaxConcurrent()).toBe(expected);
      expect(runtime.resolveAgentMaxConcurrent()).toBe(expected);
      expect(availableParallelismSpy).toHaveBeenCalledOnce();
    },
  );

  it("falls back to the CPU list when availableParallelism is unavailable", async () => {
    const availableParallelismDescriptor = Object.getOwnPropertyDescriptor(
      os,
      "availableParallelism",
    );
    if (!availableParallelismDescriptor) {
      throw new Error("expected node:os.availableParallelism descriptor");
    }
    const cpu = {
      model: "test",
      speed: 0,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    };
    const cpusSpy = vi.spyOn(os, "cpus").mockReturnValue(Array.from({ length: 6 }, () => cpu));
    Object.defineProperty(os, "availableParallelism", {
      ...availableParallelismDescriptor,
      value: undefined,
    });

    try {
      const runtime = await importFreshAgentLimits("cpus-fallback");
      expect(runtime.resolveAgentMaxConcurrent()).toBe(24);
      expect(cpusSpy).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(os, "availableParallelism", availableParallelismDescriptor);
    }
  });

  it.each([3, 256])(
    "uses an explicit limit of %i without resolving the CPU default",
    async (limit) => {
      const availableParallelismSpy = vi.spyOn(os, "availableParallelism").mockReturnValue(48);
      const runtime = await importFreshAgentLimits("explicit-override");

      expect(
        runtime.resolveAgentMaxConcurrent({ agents: { defaults: { maxConcurrent: limit } } }),
      ).toBe(limit);
      expect(availableParallelismSpy).not.toHaveBeenCalled();
    },
  );
});

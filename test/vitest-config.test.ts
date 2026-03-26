import { describe, expect, it } from "vitest";
import {
  resolveExecutionBudget,
  resolveRuntimeCapabilities,
} from "../scripts/test-planner/runtime-profile.mjs";
import { resolveLocalVitestMaxWorkers } from "../vitest.config.ts";

describe("resolveLocalVitestMaxWorkers", () => {
  it("derives a mid-tier local cap for 64 GiB hosts", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {
          RUNNER_OS: "macOS",
        },
        {
          cpuCount: 10,
          totalMemoryBytes: 64 * 1024 ** 3,
          platform: "darwin",
          loadAverage: [0.1, 0.1, 0.1],
        },
      ),
    ).toBe(4);
  });

  it("lets OPENCLAW_VITEST_MAX_WORKERS override the inferred cap", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {
          OPENCLAW_VITEST_MAX_WORKERS: "2",
        },
        {
          cpuCount: 10,
          totalMemoryBytes: 128 * 1024 ** 3,
          platform: "darwin",
        },
      ),
    ).toBe(2);
  });

  it("maps the legacy low profile to serial intent for compatibility", () => {
    const runtime = resolveRuntimeCapabilities(
      {
        OPENCLAW_TEST_PROFILE: "low",
        RUNNER_OS: "Linux",
      },
      {
        cpuCount: 8,
        totalMemoryBytes: 32 * 1024 ** 3,
        platform: "linux",
        mode: "local",
      },
    );

    expect(runtime.intentProfile).toBe("serial");
  });

  it("classifies 64 GiB local macOS hosts as mid-memory capabilities", () => {
    const runtime = resolveRuntimeCapabilities(
      {
        RUNNER_OS: "macOS",
      },
      {
        cpuCount: 10,
        totalMemoryBytes: 64 * 1024 ** 3,
        platform: "darwin",
        mode: "local",
        loadAverage: [0.2, 0.2, 0.2],
      },
    );

    expect(runtime.runtimeProfileName).toBe("local-darwin");
    expect(runtime.memoryBand).toBe("mid");
    expect(runtime.loadBand).toBe("idle");
  });

  it("does not classify 64 GiB non-macOS hosts as constrained locals", () => {
    const runtime = resolveRuntimeCapabilities(
      {
        RUNNER_OS: "Linux",
      },
      {
        cpuCount: 16,
        totalMemoryBytes: 64 * 1024 ** 3,
        platform: "linux",
        mode: "local",
        loadAverage: [0.2, 0.2, 0.2],
      },
    );

    expect(runtime.memoryBand).toBe("mid");
    expect(runtime.runtimeProfileName).toBe("local-linux");
  });

  it("reduces local budgets when the host is busy", () => {
    const runtime = resolveRuntimeCapabilities(
      {
        RUNNER_OS: "Linux",
      },
      {
        cpuCount: 10,
        totalMemoryBytes: 16 * 1024 ** 3,
        platform: "linux",
        mode: "local",
        loadAverage: [9.5, 9.5, 9.5],
      },
    );
    const budget = resolveExecutionBudget(runtime);

    expect(runtime.memoryBand).toBe("constrained");
    expect(runtime.loadBand).toBe("busy");
    expect(budget.vitestMaxWorkers).toBe(1);
    expect(budget.topLevelParallelLimit).toBe(1);
  });

  it("keeps 64 GiB hosts mid-tier but scales them down under saturation", () => {
    const runtime = resolveRuntimeCapabilities(
      {
        RUNNER_OS: "Linux",
      },
      {
        cpuCount: 10,
        totalMemoryBytes: 64 * 1024 ** 3,
        platform: "linux",
        mode: "local",
        loadAverage: [11.5, 11.5, 11.5],
      },
    );
    const budget = resolveExecutionBudget(runtime);

    expect(runtime.memoryBand).toBe("mid");
    expect(runtime.loadBand).toBe("saturated");
    expect(budget.vitestMaxWorkers).toBe(2);
    expect(budget.deferredRunConcurrency).toBe(1);
  });

  it("keeps CI windows policy constrained independently of host load", () => {
    const runtime = resolveRuntimeCapabilities(
      {
        CI: "true",
        RUNNER_OS: "Windows",
      },
      {
        cpuCount: 32,
        totalMemoryBytes: 128 * 1024 ** 3,
        platform: "win32",
        mode: "ci",
        loadAverage: [0, 0, 0],
      },
    );
    const budget = resolveExecutionBudget(runtime);

    expect(runtime.runtimeProfileName).toBe("ci-windows");
    expect(budget.vitestMaxWorkers).toBe(2);
    expect(budget.topLevelParallelLimit).toBe(2);
  });

  it("enables shared channel batching on high-memory local hosts", () => {
    const runtime = resolveRuntimeCapabilities(
      {
        RUNNER_OS: "macOS",
      },
      {
        cpuCount: 16,
        totalMemoryBytes: 128 * 1024 ** 3,
        platform: "darwin",
        mode: "local",
        loadAverage: [0.2, 0.2, 0.2],
      },
    );
    const budget = resolveExecutionBudget(runtime);

    expect(runtime.memoryBand).toBe("high");
    expect(runtime.loadBand).toBe("idle");
    expect(budget.channelsBatchTargetMs).toBe(30_000);
    expect(budget.channelSharedWorkers).toBe(5);
    expect(budget.deferredRunConcurrency).toBe(8);
    expect(budget.topLevelParallelLimitNoIsolate).toBe(14);
  });

  it("uses a coarser shared extension batch target on high-memory local hosts", () => {
    const runtime = resolveRuntimeCapabilities(
      {
        RUNNER_OS: "macOS",
      },
      {
        cpuCount: 16,
        totalMemoryBytes: 128 * 1024 ** 3,
        platform: "darwin",
        mode: "local",
        loadAverage: [0.2, 0.2, 0.2],
      },
    );
    const budget = resolveExecutionBudget(runtime);

    expect(runtime.memoryBand).toBe("high");
    expect(runtime.loadBand).toBe("idle");
    expect(budget.extensionsBatchTargetMs).toBe(300_000);
    expect(budget.extensionWorkers).toBe(5);
  });
});

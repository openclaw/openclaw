import { describe, expect, it } from "vitest";
import { resolveRuntimeProfile } from "../scripts/test-planner/runtime-profile.mjs";
import { resolveLocalVitestMaxWorkers } from "../vitest.config.ts";

describe("resolveLocalVitestMaxWorkers", () => {
  it("auto-caps local macOS mid-memory hosts to the macmini budget", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {
          RUNNER_OS: "macOS",
        },
        {
          cpuCount: 10,
          totalMemoryBytes: 64 * 1024 ** 3,
          platform: "darwin",
        },
      ),
    ).toBe(3);
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

  it("classifies mid-memory local macOS hosts as the macmini runtime profile", () => {
    expect(
      resolveRuntimeProfile(
        {
          RUNNER_OS: "macOS",
        },
        {
          cpuCount: 10,
          totalMemoryBytes: 64 * 1024 ** 3,
          platform: "darwin",
          mode: "local",
        },
      ).runtimeProfileName,
    ).toBe("macmini");
  });

  it("does not classify 64 GiB non-macOS hosts as generic low-memory locals", () => {
    const runtime = resolveRuntimeProfile(
      {
        RUNNER_OS: "Linux",
      },
      {
        cpuCount: 16,
        totalMemoryBytes: 64 * 1024 ** 3,
        platform: "linux",
        mode: "local",
      },
    );

    expect(runtime.lowMemLocalHost).toBe(false);
    expect(runtime.runtimeProfileName).toBe("local-mid-mem");
  });
});

import { describe, expect, it } from "vitest";
import { timeoutErrorMessage } from "./execution-errors.js";

describe("cron execution error formatting", () => {
  it("includes runtime plugin diagnostics during the runtime plugin phase", () => {
    const message = timeoutErrorMessage({
      jobId: "job",
      phase: "runtime_plugins",
      runtimePlugins: {
        pluginIds: ["telegram", "memory-core"],
        completedPluginIds: ["telegram"],
        inFlightPluginId: "memory-core",
        inFlightPhase: "register",
      },
    });

    expect(message).toContain("last phase: runtime-plugins");
    expect(message).toContain("attempted=[telegram, memory-core]");
    expect(message).toContain("completed=[telegram]");
    expect(message).toContain("in-flight=memory-core/register");
  });

  it("does not carry stale runtime plugin diagnostics into later phases", () => {
    expect(
      timeoutErrorMessage({
        jobId: "job",
        phase: "context_engine",
        runtimePlugins: {
          pluginIds: ["telegram"],
          completedPluginIds: ["telegram"],
        },
      }),
    ).toBe("cron: job execution timed out (last phase: context-engine)");
  });
});

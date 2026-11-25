import { describe, expect, it, vi } from "vitest";
import type { SystemAgentOperation } from "./operation-types.js";
import { executeSystemAgentOperation } from "./operations-execute.js";
import { createSystemAgentOverviewFixture } from "./overview.fixture.test-support.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const run = (...argv: string[]): SystemAgentOperation => ({ kind: "run", argv });

describe("system agent run aliases", () => {
  it("uses the host's typed read and returns redacted plain text within the output budget", async () => {
    const loadOverview = vi.fn(async () =>
      createSystemAgentOverviewFixture({
        gateway: {
          url: "ws://127.0.0.1:18789",
          source: "host fixture",
          reachable: false,
          error:
            "\u001b[31mfirst\u001b[0m\u0007 Authorization: Basic c2VjcmV0OnBhc3M=\n" +
            "lorem ".repeat(3_000) +
            "\nUNBOUNDED_TAIL",
        },
      }),
    );
    const { runtime, lines } = createSystemAgentTestRuntime();
    await expect(
      executeSystemAgentOperation(run("gateway", "status"), runtime, {
        deps: { setupSurface: "gateway", loadOverview },
      }),
    ).resolves.toEqual({ applied: false });
    expect(loadOverview).toHaveBeenCalledOnce();
    const output = lines.join("\n");
    expect(output).toContain("Source: host fixture");
    expect(output).toContain("Note: first");
    expect(output).toContain("output limit reached");
    for (const hidden of ["\u001b", "\u0007", "c2VjcmV0OnBhc3M=", "UNBOUNDED_TAIL"]) {
      expect(output).not.toContain(hidden);
    }
    expect(output.length).toBeLessThanOrEqual(8_000);
  });

  it("does not echo unsupported argv or dispatch a replacement read", async () => {
    const loadOverview = vi.fn();
    const { runtime, lines } = createSystemAgentTestRuntime();
    await executeSystemAgentOperation(run("gateway", "status", "fixture".repeat(200)), runtime, {
      deps: { setupSurface: "cli", loadOverview },
      approved: true,
    });
    expect(loadOverview).not.toHaveBeenCalled();
    expect(lines.join(" ")).toContain("not supported by run");
    expect(lines.join(" ")).not.toContain("fixture");
  });

  it("does not run a diagnostic without a host surface", async () => {
    const loadOverview = vi.fn();
    const { runtime, lines } = createSystemAgentTestRuntime();
    await executeSystemAgentOperation(run("gateway", "status"), runtime, {
      deps: { loadOverview },
    });
    expect(loadOverview).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("requires a terminal setup or hosted Ask OpenClaw");
  });

  it("reports an unexpected failure without exposing the raw exception", async () => {
    const loadOverview = async () => {
      throw new Error("PRIVATE_FIXTURE_MESSAGE");
    };
    const { runtime, lines } = createSystemAgentTestRuntime();
    await executeSystemAgentOperation(run("gateway", "status"), runtime, {
      deps: { setupSurface: "gateway", loadOverview },
    });
    expect(lines.join("\n")).toContain("could not complete");
    expect(lines.join("\n")).not.toContain("PRIVATE_FIXTURE_MESSAGE");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  captureSecretRedactionRegistrySnapshot,
  installSecretRedactionRegistrySnapshot,
  registerSecretValueForRedaction,
} from "../logging/secret-redaction-registry.js";
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
    const output = lines.join("\n");
    expect(output).toContain("Source: host fixture");
    expect(output).toContain("Note: first");
    expect(output).toContain("output limit reached");
    for (const hidden of ["\u001b", "\u0007", "c2VjcmV0OnBhc3M=", "UNBOUNDED_TAIL"]) {
      expect(output).not.toContain(hidden);
    }
    expect(output.length).toBeLessThanOrEqual(8_000);
  });

  it("redacts registered fixtures on both sides of terminal normalization", async () => {
    const registry = captureSecretRedactionRegistrySnapshot();
    const multiline = "fixture-prefix\r\nMULTILINE_CANARY-fixture-suffix";
    const styledValue = "fixture-prefix-STYLED_CANARY-fixture-suffix";
    const styled = styledValue.replace("STYLED_CANARY", "\u001b[31mSTYLED_CANARY\u001b[0m");
    registerSecretValueForRedaction(multiline);
    registerSecretValueForRedaction(styledValue);
    try {
      const { runtime, lines } = createSystemAgentTestRuntime();
      const loadOverview = async () => {
        const overview = createSystemAgentOverviewFixture();
        overview.gateway.error = ["fixture diagnostic", multiline, styled].join("\n");
        return overview;
      };
      await executeSystemAgentOperation(run("gateway", "status"), runtime, {
        deps: { setupSurface: "gateway", loadOverview },
      });
      const output = lines.join("\n");
      expect(output).toContain("Note: fixture diagnostic");
      for (const hidden of ["\u001b", "\r", "MULTILINE_CANARY", "STYLED_CANARY"]) {
        expect(output).not.toContain(hidden);
      }
    } finally {
      installSecretRedactionRegistrySnapshot(registry);
    }
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

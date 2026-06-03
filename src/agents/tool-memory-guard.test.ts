import { describe, expect, it } from "vitest";
import {
  __testing,
  evaluateToolMemoryGuard,
  resolveToolMemoryGuardConfig,
} from "./tool-memory-guard.js";

describe("tool memory guard", () => {
  it("parses Linux MemAvailable from /proc/meminfo", () => {
    const snapshot = __testing.parseProcMeminfo(
      [
        "MemTotal:       16384000 kB",
        "MemFree:          100000 kB",
        "MemAvailable:     512000 kB",
      ].join("\n"),
    );

    expect(snapshot).toEqual({
      availableBytes: 512000 * 1024,
      totalBytes: 16384000 * 1024,
      source: "proc-meminfo",
    });
  });

  it("blocks when available memory is below the configured floor", () => {
    const decision = evaluateToolMemoryGuard({
      config: { enabled: true, minAvailableBytes: 300 * 1024 * 1024, minAvailablePercent: 5 },
      snapshot: {
        availableBytes: 128 * 1024 * 1024,
        totalBytes: 8 * 1024 * 1024 * 1024,
        source: "proc-meminfo",
      },
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain("Tool call blocked because host memory is low");
      expect(decision.reason).toContain("128 MiB available");
    }
  });

  it("merges agent memory guard settings over global settings", () => {
    const config = resolveToolMemoryGuardConfig({
      agentId: "lily",
      cfg: {
        tools: {
          memoryGuard: {
            enabled: true,
            minAvailableBytes: 1024,
            minAvailablePercent: 10,
          },
        },
        agents: {
          list: [
            {
              id: "lily",
              tools: {
                memoryGuard: {
                  minAvailablePercent: 3,
                },
              },
            },
          ],
        },
      },
    });

    expect(config).toEqual({
      enabled: true,
      minAvailableBytes: 1024,
      minAvailablePercent: 3,
    });
  });
});

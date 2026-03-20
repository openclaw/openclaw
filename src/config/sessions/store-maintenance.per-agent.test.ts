import { describe, expect, it, vi } from "vitest";

// Mock config loading to control test inputs.
vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

import { loadConfig } from "../config.js";
import { resolveMaintenanceConfig } from "./store-maintenance.js";

const mockLoadConfig = vi.mocked(loadConfig);

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Per-agent session maintenance config resolution.
// ---------------------------------------------------------------------------

describe("resolveMaintenanceConfig with agentId", () => {
  it("returns global config when no agentId is provided", () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "7d",
          maxEntries: 200,
        },
      },
      agents: {
        list: [
          {
            id: "worker",
            maintenance: { mode: "warn", maxEntries: 50 },
          },
        ],
      },
    } as ReturnType<typeof loadConfig>);

    const result = resolveMaintenanceConfig();

    expect(result.mode).toBe("enforce");
    expect(result.maxEntries).toBe(200);
    expect(result.pruneAfterMs).toBe(7 * DAY_MS);
  });

  it("merges per-agent overrides over global config", () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 500,
          rotateBytes: "10mb",
        },
      },
      agents: {
        list: [
          {
            id: "approval",
            maintenance: {
              mode: "warn",
              maxEntries: 50,
              pruneAfter: "1d",
            },
          },
        ],
      },
    } as ReturnType<typeof loadConfig>);

    const result = resolveMaintenanceConfig("approval");

    expect(result.mode).toBe("warn");
    expect(result.maxEntries).toBe(50);
    expect(result.pruneAfterMs).toBe(1 * DAY_MS);
    // rotateBytes falls through from global.
    expect(result.rotateBytes).toBe(10_485_760);
  });

  it("falls through to global when agent has no maintenance config", () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          maxEntries: 300,
        },
      },
      agents: {
        list: [{ id: "worker" }],
      },
    } as ReturnType<typeof loadConfig>);

    const result = resolveMaintenanceConfig("worker");

    expect(result.mode).toBe("enforce");
    expect(result.maxEntries).toBe(300);
  });

  it("falls through to global when agent is not found in list", () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          maxEntries: 100,
        },
      },
      agents: {
        list: [{ id: "other" }],
      },
    } as ReturnType<typeof loadConfig>);

    const result = resolveMaintenanceConfig("nonexistent");

    expect(result.mode).toBe("enforce");
    expect(result.maxEntries).toBe(100);
  });

  it("uses built-in defaults when no global or per-agent config exists", () => {
    mockLoadConfig.mockReturnValue({} as ReturnType<typeof loadConfig>);

    const result = resolveMaintenanceConfig("any-agent");

    expect(result.mode).toBe("warn");
    expect(result.maxEntries).toBe(500);
    expect(result.pruneAfterMs).toBe(30 * DAY_MS);
    expect(result.rotateBytes).toBe(10_485_760);
  });

  it("per-agent maxDiskBytes/highWaterBytes override global", () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          maxDiskBytes: "200mb",
        },
      },
      agents: {
        list: [
          {
            id: "heavy",
            maintenance: {
              maxDiskBytes: "500mb",
              highWaterBytes: "400mb",
            },
          },
        ],
      },
    } as ReturnType<typeof loadConfig>);

    const result = resolveMaintenanceConfig("heavy");

    expect(result.maxDiskBytes).toBe(500 * 1024 * 1024);
    expect(result.highWaterBytes).toBe(400 * 1024 * 1024);
  });

  it("per-agent config without global maintenance still works", () => {
    mockLoadConfig.mockReturnValue({
      agents: {
        list: [
          {
            id: "standalone",
            maintenance: {
              mode: "enforce",
              pruneAfter: "2d",
              maxEntries: 10,
            },
          },
        ],
      },
    } as ReturnType<typeof loadConfig>);

    const result = resolveMaintenanceConfig("standalone");

    expect(result.mode).toBe("enforce");
    expect(result.maxEntries).toBe(10);
    expect(result.pruneAfterMs).toBe(2 * DAY_MS);
  });
});

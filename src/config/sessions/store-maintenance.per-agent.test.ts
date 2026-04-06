import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config loading to control test inputs.
vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

let loadConfig: typeof import("../config.js").loadConfig;
let resolveMaintenanceConfig: typeof import("./store-maintenance.js").resolveMaintenanceConfig;
let mockLoadConfig: ReturnType<typeof vi.fn>;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Per-agent session maintenance config resolution.
// ---------------------------------------------------------------------------

describe("resolveMaintenanceConfig with agentId", () => {
  beforeAll(async () => {
    ({ loadConfig } = await import("../config.js"));
    ({ resolveMaintenanceConfig } = await import("./store-maintenance.js"));
    mockLoadConfig = vi.mocked(loadConfig) as ReturnType<typeof vi.fn>;
  });

  beforeEach(() => {
    mockLoadConfig.mockClear();
  });

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
    });

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
    });

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
    });

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
    });

    const result = resolveMaintenanceConfig("nonexistent");

    expect(result.mode).toBe("enforce");
    expect(result.maxEntries).toBe(100);
  });

  it("uses built-in defaults when no global or per-agent config exists", () => {
    mockLoadConfig.mockReturnValue({});

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
    });

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
    });

    const result = resolveMaintenanceConfig("standalone");

    expect(result.mode).toBe("enforce");
    expect(result.maxEntries).toBe(10);
    expect(result.pruneAfterMs).toBe(2 * DAY_MS);
  });
});

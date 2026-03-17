import { describe, expect, it, vi, beforeEach } from "vitest";

const writtenConfigs: unknown[] = [];

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ gateway: { oag: { delivery: { maxRetries: 5 } } } }),
  writeConfigFile: vi.fn(async (cfg: unknown) => {
    writtenConfigs.push(JSON.parse(JSON.stringify(cfg)));
  }),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const { applyOagConfigChanges } = await import("./oag-config-writer.js");

describe("oag-config-writer", () => {
  beforeEach(() => {
    writtenConfigs.length = 0;
  });

  it("writes merged config with OAG changes", async () => {
    const result = await applyOagConfigChanges([
      { configPath: "gateway.oag.delivery.recoveryBudgetMs", value: 90000 },
    ]);
    expect(result.applied).toBe(true);
    expect(writtenConfigs).toHaveLength(1);
    const written = writtenConfigs[0] as Record<string, unknown>;
    const gw = written.gateway as Record<string, unknown>;
    const oag = gw.oag as Record<string, unknown>;
    const delivery = oag.delivery as Record<string, unknown>;
    expect(delivery.recoveryBudgetMs).toBe(90000);
    // Existing config preserved
    expect(delivery.maxRetries).toBe(5);
  });

  it("does not write in dry-run mode", async () => {
    const result = await applyOagConfigChanges(
      [{ configPath: "gateway.oag.lock.staleMs", value: 60000 }],
      { dryRun: true },
    );
    expect(result.applied).toBe(false);
    expect(result.config).toBeDefined();
    expect(writtenConfigs).toHaveLength(0);
  });

  it("returns applied=false when no changes", async () => {
    const result = await applyOagConfigChanges([]);
    expect(result.applied).toBe(false);
  });

  it("handles nested path creation", async () => {
    const result = await applyOagConfigChanges([
      { configPath: "gateway.oag.health.stalePollFactor", value: 3 },
    ]);
    expect(result.applied).toBe(true);
    const written = writtenConfigs[0] as Record<string, unknown>;
    const gw = written.gateway as Record<string, unknown>;
    const oag = gw.oag as Record<string, unknown>;
    const health = oag.health as Record<string, unknown>;
    expect(health.stalePollFactor).toBe(3);
  });

  it("rejects config paths outside the gateway.oag. namespace", async () => {
    await expect(
      applyOagConfigChanges([{ configPath: "gateway.channels.telegram.enabled", value: true }]),
    ).rejects.toThrow('OAG config path must start with "gateway.oag."');
  });

  it("rejects a bare path without gateway.oag. prefix", async () => {
    await expect(applyOagConfigChanges([{ configPath: "debug", value: true }])).rejects.toThrow(
      'OAG config path must start with "gateway.oag."',
    );
  });

  it("throws when an intermediate path segment is not a plain object", async () => {
    // loadConfig returns { gateway: { oag: { delivery: { maxRetries: 5 } } } }
    // delivery.maxRetries is a number, so traversing through it should throw
    await expect(
      applyOagConfigChanges([{ configPath: "gateway.oag.delivery.maxRetries.nested", value: 1 }]),
    ).rejects.toThrow("is not a plain object");
  });

  it("accepts channel-scoped OAG config paths", async () => {
    const result = await applyOagConfigChanges([
      { configPath: "gateway.oag.channels.telegram.delivery.maxRetries", value: 8 },
    ]);
    expect(result.applied).toBe(true);
    expect(writtenConfigs).toHaveLength(1);
    const written = writtenConfigs[0] as Record<string, unknown>;
    const gw = written.gateway as Record<string, unknown>;
    const oag = gw.oag as Record<string, unknown>;
    const channels = oag.channels as Record<string, unknown>;
    const telegram = channels.telegram as Record<string, unknown>;
    const delivery = telegram.delivery as Record<string, unknown>;
    expect(delivery.maxRetries).toBe(8);
  });

  it("still rejects non-OAG paths with channels-like structure", async () => {
    await expect(
      applyOagConfigChanges([
        { configPath: "gateway.channels.telegram.delivery.maxRetries", value: 8 },
      ]),
    ).rejects.toThrow('OAG config path must start with "gateway.oag."');
  });
});

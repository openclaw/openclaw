import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  getRuntimeConfigSnapshot: vi.fn(() => null),
}));

import { getRuntimeConfigSnapshot } from "../../config/config.js";
import {
  clampDelayMs,
  resolveContinuationRuntimeConfig,
  resolveLiveContinuationRuntimeConfig,
} from "./config.js";
import type { ContinuationRuntimeConfig } from "./types.js";

const getRuntimeConfigSnapshotMock = vi.mocked(getRuntimeConfigSnapshot);

describe("resolveContinuationRuntimeConfig", () => {
  it("returns defaults when continuation is not configured", () => {
    const config = resolveContinuationRuntimeConfig({} as never);
    expect(config).toMatchObject({
      enabled: false,

      defaultDelayMs: 15_000,
      minDelayMs: 5_000,
      maxDelayMs: 300_000,
      maxChainLength: 10,
      costCapTokens: 500_000,
      maxDelegatesPerTurn: 5,
      earlyWarningBand: 0.3125,
    });
    expect(config.contextPressureThreshold).toBeUndefined();
  });

  it("resolves configured values with clamping", () => {
    const config = resolveContinuationRuntimeConfig({
      agents: {
        defaults: {
          continuation: {
            enabled: true,

            maxChainLength: 100,
            costCapTokens: 0,
            maxDelegatesPerTurn: 20,
            contextPressureThreshold: 0.8,
            earlyWarningBand: 0,
            defaultDelayMs: 30_000,
            minDelayMs: 1_000,
            maxDelayMs: 600_000,
          },
        },
      },
    } as never);
    expect(config).toMatchObject({
      enabled: true,

      maxChainLength: 100,
      costCapTokens: 0,
      maxDelegatesPerTurn: 20,
      contextPressureThreshold: 0.8,
      earlyWarningBand: 0,
      defaultDelayMs: 30_000,
      minDelayMs: 1_000,
      maxDelayMs: 600_000,
    });
  });

  it("clamps negative values to defaults", () => {
    const config = resolveContinuationRuntimeConfig({
      agents: {
        defaults: {
          continuation: {
            maxChainLength: -5,
            costCapTokens: -1,
            maxDelegatesPerTurn: 0,
          },
        },
      },
    } as never);
    expect(config.maxChainLength).toBe(10);
    expect(config.costCapTokens).toBe(500_000);
    expect(config.maxDelegatesPerTurn).toBe(5);
  });

  it("rejects invalid contextPressureThreshold", () => {
    expect(
      resolveContinuationRuntimeConfig({
        agents: { defaults: { continuation: { contextPressureThreshold: 0 } } },
      } as never).contextPressureThreshold,
    ).toBeUndefined();
    expect(
      resolveContinuationRuntimeConfig({
        agents: { defaults: { continuation: { contextPressureThreshold: 1.5 } } },
      } as never).contextPressureThreshold,
    ).toBeUndefined();
  });

  it("defaults invalid earlyWarningBand and preserves explicit opt-out", () => {
    expect(
      resolveContinuationRuntimeConfig({
        agents: { defaults: { continuation: { earlyWarningBand: 0 } } },
      } as never).earlyWarningBand,
    ).toBe(0);
    expect(
      resolveContinuationRuntimeConfig({
        agents: { defaults: { continuation: { earlyWarningBand: 1.5 } } },
      } as never).earlyWarningBand,
    ).toBe(0.3125);
  });

  it("has no generationGuardTolerance field", () => {
    const config = resolveContinuationRuntimeConfig({} as never);
    expect("generationGuardTolerance" in config).toBe(false);
  });

  it("prefers the active runtime snapshot when resolving live config", () => {
    getRuntimeConfigSnapshotMock.mockReturnValueOnce({
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 9 } } },
    } as never);

    const config = resolveLiveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 3 } } },
    } as never);

    expect(config.maxDelegatesPerTurn).toBe(9);
  });

  it("falls back to the provided config when no runtime snapshot is active", () => {
    const config = resolveLiveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 4 } } },
    } as never);

    expect(config.maxDelegatesPerTurn).toBe(4);
  });

  it("uses active runtime snapshot defaults when continuation config was unset", () => {
    getRuntimeConfigSnapshotMock.mockReturnValueOnce({} as never);

    const config = resolveLiveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 6 } } },
    } as never);

    expect(config.maxDelegatesPerTurn).toBe(5);
  });
});

describe("clampDelayMs", () => {
  const config: ContinuationRuntimeConfig = {
    enabled: true,

    defaultDelayMs: 15_000,
    minDelayMs: 5_000,
    maxDelayMs: 300_000,
    maxChainLength: 10,
    costCapTokens: 500_000,
    maxDelegatesPerTurn: 5,
    earlyWarningBand: 0.3125,
  };

  it("uses default when undefined", () => {
    expect(clampDelayMs(undefined, config)).toBe(15_000);
  });

  it("clamps below minimum", () => {
    expect(clampDelayMs(1_000, config)).toBe(5_000);
  });

  it("clamps above maximum", () => {
    expect(clampDelayMs(600_000, config)).toBe(300_000);
  });

  it("passes through values in range", () => {
    expect(clampDelayMs(60_000, config)).toBe(60_000);
  });
});

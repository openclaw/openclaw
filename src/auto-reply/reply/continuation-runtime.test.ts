import { beforeEach, describe, expect, it, vi } from "vitest";

let configOverride: ReturnType<(typeof import("../../config/config.js"))["loadConfig"]> = {};

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

import {
  resolveContinuationRuntimeConfig,
  resolveMaxDelegatesPerTurn,
} from "./continuation-runtime.js";

describe("continuation runtime config", () => {
  beforeEach(() => {
    configOverride = {};
  });

  it("clamps invalid numeric values back to safe defaults", () => {
    configOverride = {
      agents: {
        defaults: {
          continuation: {
            enabled: true,
            defaultDelayMs: -1,
            minDelayMs: Number.NaN,
            maxDelayMs: -10,
            maxChainLength: 0,
            costCapTokens: -50,
            maxDelegatesPerTurn: 0,
            generationGuardTolerance: -3,
            contextPressureThreshold: 2,
          },
        },
      },
    };

    expect(resolveContinuationRuntimeConfig()).toEqual({
      enabled: true,
      defaultDelayMs: 15_000,
      minDelayMs: 5_000,
      maxDelayMs: 300_000,
      maxChainLength: 10,
      costCapTokens: 500_000,
      maxDelegatesPerTurn: 5,
      generationGuardTolerance: 0,
      contextPressureThreshold: undefined,
    });
  });

  it("truncates positive numeric fields while preserving valid fractional thresholds", () => {
    configOverride = {
      agents: {
        defaults: {
          continuation: {
            defaultDelayMs: 15_999.8,
            minDelayMs: 5_001.2,
            maxDelayMs: 300_999.7,
            maxChainLength: 2.9,
            costCapTokens: 1234.8,
            maxDelegatesPerTurn: 7.6,
            generationGuardTolerance: 4.9,
            contextPressureThreshold: 0.8,
          },
        },
      },
    };

    expect(resolveContinuationRuntimeConfig()).toMatchObject({
      defaultDelayMs: 15_999,
      minDelayMs: 5_001,
      maxDelayMs: 300_999,
      maxChainLength: 2,
      costCapTokens: 1234,
      maxDelegatesPerTurn: 7,
      generationGuardTolerance: 4,
      contextPressureThreshold: 0.8,
    });
  });

  it("allows zero delay bounds for runtime-only/test overrides", () => {
    configOverride = {
      agents: {
        defaults: {
          continuation: {
            defaultDelayMs: 0,
            minDelayMs: 0,
            maxDelayMs: 0,
          },
        },
      },
    };

    expect(resolveContinuationRuntimeConfig()).toMatchObject({
      defaultDelayMs: 0,
      minDelayMs: 0,
      maxDelayMs: 0,
    });
  });

  it("exposes resolveMaxDelegatesPerTurn as a live convenience accessor", () => {
    configOverride = {
      agents: {
        defaults: {
          continuation: {
            maxDelegatesPerTurn: 12,
          },
        },
      },
    };

    expect(resolveMaxDelegatesPerTurn()).toBe(12);
  });
});

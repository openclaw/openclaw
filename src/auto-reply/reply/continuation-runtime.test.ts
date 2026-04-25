import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../../config/io.js";
import {
  resolveContinuationRuntimeConfig,
  resolveMaxDelegatesPerTurn,
} from "./continuation-runtime.js";

describe("continuation runtime config", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("clamps invalid numeric values back to safe defaults", () => {
    setRuntimeConfigSnapshot({
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
            contextPressureThreshold: 2,
          },
        },
      },
    } as Parameters<typeof setRuntimeConfigSnapshot>[0]);

    expect(resolveContinuationRuntimeConfig()).toEqual({
      enabled: true,
      taskFlowDelegates: false,
      defaultDelayMs: 15_000,
      minDelayMs: 5_000,
      maxDelayMs: 300_000,
      maxChainLength: 10,
      costCapTokens: 500_000,
      maxDelegatesPerTurn: 5,
      contextPressureThreshold: undefined,
    });
  });

  it("truncates positive numeric fields while preserving valid fractional thresholds", () => {
    setRuntimeConfigSnapshot({
      agents: {
        defaults: {
          continuation: {
            defaultDelayMs: 15_999.8,
            minDelayMs: 5_001.2,
            maxDelayMs: 300_999.7,
            maxChainLength: 2.9,
            costCapTokens: 1234.8,
            maxDelegatesPerTurn: 7.6,
            contextPressureThreshold: 0.8,
          },
        },
      },
    } as Parameters<typeof setRuntimeConfigSnapshot>[0]);

    expect(resolveContinuationRuntimeConfig()).toMatchObject({
      defaultDelayMs: 15_999,
      minDelayMs: 5_001,
      maxDelayMs: 300_999,
      maxChainLength: 2,
      costCapTokens: 1234,
      maxDelegatesPerTurn: 7,
      contextPressureThreshold: 0.8,
    });
  });

  it("treats non-positive contextPressureThreshold values as unset", () => {
    setRuntimeConfigSnapshot({
      agents: {
        defaults: {
          continuation: {
            contextPressureThreshold: 0,
          },
        },
      },
    } as Parameters<typeof setRuntimeConfigSnapshot>[0]);

    expect(resolveContinuationRuntimeConfig()).toMatchObject({
      contextPressureThreshold: undefined,
    });
  });

  it("allows zero delay bounds for runtime-only/test overrides", () => {
    setRuntimeConfigSnapshot({
      agents: {
        defaults: {
          continuation: {
            defaultDelayMs: 0,
            minDelayMs: 0,
            maxDelayMs: 0,
          },
        },
      },
    } as Parameters<typeof setRuntimeConfigSnapshot>[0]);

    expect(resolveContinuationRuntimeConfig()).toMatchObject({
      defaultDelayMs: 0,
      minDelayMs: 0,
      maxDelayMs: 0,
    });
  });

  it("exposes resolveMaxDelegatesPerTurn as a live convenience accessor", () => {
    setRuntimeConfigSnapshot({
      agents: {
        defaults: {
          continuation: {
            maxDelegatesPerTurn: 12,
          },
        },
      },
    } as Parameters<typeof setRuntimeConfigSnapshot>[0]);

    expect(resolveMaxDelegatesPerTurn()).toBe(12);
  });
});

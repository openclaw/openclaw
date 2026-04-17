import { describe, expect, it } from "vitest";
import { resolvePreferredStatusA2AInput } from "./status.a2a-input.js";
import type { StatusSummary } from "./status.types.js";

function createSummary(overrides: Partial<Pick<StatusSummary, "contributors" | "a2a">>) {
  return {
    contributors: [],
    a2a: {
      state: "ok",
      tasks: {
        total: 0,
        active: 0,
        failed: 0,
        waitingExternal: 0,
        delayed: 0,
        latestFailed: null,
      },
      issues: {
        brokerUnreachable: 0,
        reconcileFailed: 0,
        deliveryFailed: 0,
        cancelNotAttempted: 0,
        sessionAbortFailed: 0,
      },
      broker: {
        pluginEnabled: true,
        adapterEnabled: true,
        baseUrlPresent: true,
        edgeSecretPresent: true,
        methodScopesOk: true,
      },
    },
    ...overrides,
  } satisfies Pick<StatusSummary, "contributors" | "a2a">;
}

describe("resolvePreferredStatusA2AInput", () => {
  it("prefers contributor-owned a2a input over summary.a2a fallback", () => {
    const input = resolvePreferredStatusA2AInput({
      summary: createSummary({
        contributors: [
          {
            id: "a2a",
            label: "A2A",
            state: "info",
            summary: "plugin-owned broker status",
            details: ["1 active"],
          },
        ],
        a2a: {
          ...createSummary({}).a2a,
          state: "failed",
        },
      }),
    });

    expect(input).toEqual({
      source: "contributor",
      state: "info",
      summary: "plugin-owned broker status",
      details: ["1 active"],
    });
  });

  it("uses summary.a2a fallback when no a2a contributor is present", () => {
    const input = resolvePreferredStatusA2AInput({
      summary: createSummary({
        contributors: [
          {
            id: "diag",
            label: "Diag",
            state: "ok",
            summary: "healthy",
            details: [],
          },
        ],
        a2a: {
          ...createSummary({}).a2a,
          state: "waiting_external",
          tasks: {
            ...createSummary({}).a2a.tasks,
            waitingExternal: 2,
          },
          broker: {
            ...createSummary({}).a2a.broker,
            adapterEnabled: false,
          },
        },
      }),
    });

    expect(input).toEqual({
      source: "summary.a2a",
      state: "warn",
      summary: "waiting external",
      details: ["broker off", "no active", "2 waiting external"],
    });
  });

  it("ignores blank or invalid a2a contributor and keeps summary.a2a fallback", () => {
    const input = resolvePreferredStatusA2AInput({
      summary: createSummary({
        contributors: [
          {
            id: "a2a",
            label: "A2A",
            state: "warn",
            summary: " ",
            details: [" "],
          },
        ],
        a2a: {
          ...createSummary({}).a2a,
          state: "failed",
          tasks: {
            ...createSummary({}).a2a.tasks,
            failed: 1,
          },
          broker: {
            ...createSummary({}).a2a.broker,
            adapterEnabled: false,
          },
        },
      }),
    });

    expect(input).toEqual({
      source: "summary.a2a",
      state: "error",
      summary: "failed",
      details: ["broker off", "no active", "1 failed"],
    });
  });
});

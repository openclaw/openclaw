// Runtime-config drift text rendering for `openclaw health`.
import { describe, expect, it } from "vitest";
import type { HealthSummary } from "../gateway/health/types.js";
import { formatRuntimeConfigHealthLine } from "./health-runtime-config.js";

function summaryWith(runtimeConfig?: HealthSummary["runtimeConfig"]): HealthSummary {
  return (runtimeConfig ? { runtimeConfig } : {}) as HealthSummary;
}

describe("formatRuntimeConfigHealthLine", () => {
  it("returns null when runtimeConfig is absent or state is ok", () => {
    expect(formatRuntimeConfigHealthLine(summaryWith())).toBeNull();
    expect(
      formatRuntimeConfigHealthLine(
        summaryWith({ state: "ok", liveDefaultModel: "openai/gpt-5.5" }),
      ),
    ).toBeNull();
  });

  it("renders the drift warning with paths and live/observed model labels", () => {
    const summary = summaryWith({
      state: "drift",
      driftPaths: ["gateway.auth"],
      liveDefaultModel: "openai/gpt-5.5",
      observedDefaultModel: "openai/gpt-5.5",
      message: "Live gateway runtime config differs from the latest completed reload observation.",
    });

    expect(formatRuntimeConfigHealthLine(summary)).toBe(
      "Runtime config: warning (live gateway differs from latest completed reload observation for gateway.auth; restart required or pending; live=openai/gpt-5.5 observed=openai/gpt-5.5)",
    );
  });

  it.each([
    [
      "Latest completed reload source observation is unavailable.",
      "Runtime config: warning (unknown source: Latest completed reload source observation is unavailable.)",
    ],
    [
      "Runtime source config snapshot is unavailable.",
      "Runtime config: warning (unknown source: Runtime source config snapshot is unavailable.)",
    ],
    [undefined, "Runtime config: warning (unknown source: config source unavailable)"],
  ])("renders unknown state %j with a source-neutral prefix", (message, expected) => {
    const summary = summaryWith({ state: "unknown", ...(message ? { message } : {}) });
    expect(formatRuntimeConfigHealthLine(summary)).toBe(expected);
  });
});

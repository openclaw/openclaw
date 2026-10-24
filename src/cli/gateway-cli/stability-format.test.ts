import { describe, expect, it } from "vitest";
import { formatStabilityEvent } from "./stability-format.js";

describe("provider timing in stability output", () => {
  it("labels reported processing and estimated wait separately from wall time", () => {
    expect(
      formatStabilityEvent({
        seq: 1,
        ts: 0,
        type: "model.call.completed",
        provider: "llama-cpp",
        model: "local-model",
        durationMs: 130,
        providerProcessingMs: 20.25,
        providerWaitEstimateMs: 109.75,
      }),
    ).toBe(
      "1970-01-01T00:00:00.000Z #1 model.call.completed provider=llama-cpp model=local-model wall=130ms processing=20ms wait~=110ms",
    );
  });

  it("keeps cancelled timing unknown when the provider returned no final statistics", () => {
    expect(
      formatStabilityEvent({
        seq: 2,
        ts: 0,
        type: "model.call.error",
        durationMs: 30,
        failureKind: "aborted",
      }),
    ).toBe("1970-01-01T00:00:00.000Z #2 model.call.error wall=30ms failure=aborted");
  });

  it("retains measured zero durations", () => {
    expect(
      formatStabilityEvent({
        seq: 3,
        ts: 0,
        type: "model.call.completed",
        durationMs: 0,
        providerProcessingMs: 0,
        providerWaitEstimateMs: 0,
      }),
    ).toContain("wall=0ms processing=0ms wait~=0ms");
  });
});

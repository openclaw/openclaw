import { describe, expect, it } from "vitest";
import { formatStabilityEvent } from "./stability-format.js";

describe("provider timing in stability output", () => {
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
});

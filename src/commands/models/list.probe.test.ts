import { describe, expect, it } from "vitest";
import { mapFailoverReasonToProbeStatus } from "./list.probe.js";

describe("mapFailoverReasonToProbeStatus", () => {
  it("maps auth_permanent to auth", () => {
    expect(mapFailoverReasonToProbeStatus("auth_permanent")).toBe("auth");
  });

  it("keeps existing failover reason mappings", () => {
    expect(mapFailoverReasonToProbeStatus("auth")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("rate_limit")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("billing")).toBe("billing");
    expect(mapFailoverReasonToProbeStatus("timeout")).toBe("timeout");
    expect(mapFailoverReasonToProbeStatus("format")).toBe("format");
  });

  it("falls back to unknown for unrecognized values", () => {
    expect(mapFailoverReasonToProbeStatus(undefined)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus(null)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus("model_not_found")).toBe("unknown");
  });
});

import { describe, expect, it } from "vitest";
import { teammateGatewayExecViolation, resolveTeammateExecPlacement } from "./exec-bind.js";
import { applyTeammateProfile } from "./profile.js";

describe("teammate exec bind", () => {
  it("never reports gateway exec for a teammate profile", () => {
    const cfg = applyTeammateProfile({}, { homeDir: "/tmp/bot-home" });
    const placement = resolveTeammateExecPlacement(cfg);
    expect(placement.effectiveHost).toBe("sandbox");
    expect(placement.gatewayExec).toBe(false);
    expect(teammateGatewayExecViolation(cfg)).toBeNull();
  });

  it("flags a teammate install that was later pinned back to gateway exec", () => {
    const cfg = applyTeammateProfile(
      { tools: { exec: { host: "gateway" } } },
      { homeDir: "/tmp/bot-home" },
    );
    // applyTeammateProfile overwrites exec.host to sandbox; simulate operator drift.
    const drifted = {
      ...cfg,
      tools: { ...cfg.tools, exec: { ...cfg.tools?.exec, host: "gateway" as const } },
    };
    const violation = teammateGatewayExecViolation(drifted);
    expect(violation?.gatewayExec).toBe(true);
    expect(violation?.effectiveHost).toBe("gateway");
  });
});

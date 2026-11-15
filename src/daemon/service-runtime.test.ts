// Tests for systemd supervision-state classification helpers.
import { describe, expect, it } from "vitest";
import { isSystemdStartLimitHit } from "./service-runtime.js";

describe("isSystemdStartLimitHit", () => {
  it("does not counter-detect the deliberate EX_CONFIG (78) no-restart exit", () => {
    // RestartPreventExitStatus=78 stops systemd on purpose; the NRestarts left
    // over from earlier crashes is stale and must not read as start-limit exhaustion.
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        lastExitStatus: 78,
        systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
      }),
    ).toBe(false);
  });

  it("keeps Result=start-limit-hit authoritative even after a config (78) exit", () => {
    // The explicit systemd give-up signal wins regardless of the last exit code.
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        lastExitStatus: 78,
        systemd: { result: "start-limit-hit", nRestarts: 5, startLimitBurst: 5 },
      }),
    ).toBe(true);
  });

  it("does not flag a single failed exit below the start limit", () => {
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 1, startLimitBurst: 5 },
      }),
    ).toBe(false);
  });

  it("returns false without systemd supervision data or runtime", () => {
    expect(isSystemdStartLimitHit({ status: "stopped", state: "failed" })).toBe(false);
    expect(isSystemdStartLimitHit(undefined)).toBe(false);
  });
});

// Tests for systemd supervision-state classification helpers.
import { describe, expect, it } from "vitest";
import { isSystemdStartLimitHit } from "./service-runtime.js";

describe("isSystemdStartLimitHit", () => {
  it("detects a crash loop where the restart counter reached StartLimitBurst", () => {
    // Real systemd 249 give-up: process kept exiting non-zero so Result stays
    // exit-code; NRestarts hitting StartLimitBurst is the give-up signal.
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
      }),
    ).toBe(true);
  });

  it("detects Result=start-limit-hit even when restart counters are absent", () => {
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        systemd: { result: "start-limit-hit" },
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

  it("does not flag a running unit even if its lifetime restart count is high", () => {
    expect(
      isSystemdStartLimitHit({
        status: "running",
        state: "active",
        systemd: { result: "success", nRestarts: 9, startLimitBurst: 5 },
      }),
    ).toBe(false);
  });

  it("does not flag when rate limiting is disabled (StartLimitBurst=0)", () => {
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 9, startLimitBurst: 0 },
      }),
    ).toBe(false);
  });

  it("does not counter-detect when StartLimitBurst is missing from the probe", () => {
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 9 },
      }),
    ).toBe(false);
  });

  it("returns false without systemd supervision data or runtime", () => {
    expect(isSystemdStartLimitHit({ status: "stopped", state: "failed" })).toBe(false);
    expect(isSystemdStartLimitHit(undefined)).toBe(false);
  });
});

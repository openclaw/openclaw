import { describe, expect, it } from "vitest";
import {
  formatDoctorNonInteractiveHint,
  formatRestartSentinelMessage,
  summarizeRestartSentinel,
  trimLogTail,
} from "./restart-sentinel.js";

describe("restart sentinel formatting", () => {
  it("uses the exact auto-recovery message for config recovery notices", () => {
    const payload = {
      kind: "config-auto-recovery" as const,
      status: "ok" as const,
      ts: Date.now(),
      message:
        "Gateway recovered automatically after a failed config change and restored the last known good configuration.",
      stats: { mode: "config-auto-recovery", reason: "gateway-run-invalid-config" },
    };

    expect(formatRestartSentinelMessage(payload)).toBe(payload.message);
    expect(summarizeRestartSentinel(payload)).toBe("Gateway auto-recovery");
  });

  it("formats config write success notices as restart required when marked", () => {
    const payload = {
      kind: "config-patch" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Run restart-gateway.ps1 to apply config changes.",
      doctorHint: "Run openclaw doctor --non-interactive",
      stats: { mode: "config.patch", requiresRestart: true },
    };

    expect(formatRestartSentinelMessage(payload)).toBe(
      [
        "Gateway restart required (config.patch)",
        "Run restart-gateway.ps1 to apply config changes.",
        "Run openclaw doctor --non-interactive",
      ].join("\n"),
    );
    expect(summarizeRestartSentinel(payload)).toBe("Gateway restart required (config.patch)");

    expect(
      summarizeRestartSentinel({
        kind: "config-apply",
        status: "ok",
        ts: Date.now(),
        stats: { mode: "config.apply", requiresRestart: true },
      }),
    ).toBe("Gateway restart required (config.apply)");
  });

  it("keeps trimmed log tails UTF-16 safe", () => {
    expect(trimLogTail("prefix🤖tail", 5)).toBe("…tail");
  });

  it("formats restart messages without volatile timestamps", () => {
    const payloadA = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: 100,
      message: "Restart requested by /restart",
      stats: { mode: "gateway.restart", reason: "/restart" },
    };
    const payloadB = { ...payloadA, ts: 200 };
    const textA = formatRestartSentinelMessage(payloadA);
    const textB = formatRestartSentinelMessage(payloadB);
    expect(textA).toBe(textB);
    expect(textA).toContain("Gateway restart ok");
    expect(textA).not.toContain("Gateway restart restart");
    expect(textA).not.toContain('"ts"');
  });

  it("summarizes restart payloads and trims log tails without trailing whitespace", () => {
    expect(
      summarizeRestartSentinel({
        kind: "update",
        status: "skipped",
        ts: 1,
      }),
    ).toBe("Gateway restart update skipped");
    expect(trimLogTail("hello\n")).toBe("hello");
    expect(trimLogTail(undefined)).toBeNull();
  });
});

describe("restart sentinel message dedup", () => {
  it("keeps profile-aware doctor guidance actionable outside constrained delivery surfaces", () => {
    expect(
      formatDoctorNonInteractiveHint({
        OPENCLAW_PROFILE: "isolated",
        PATH: "/usr/bin:/bin",
      }),
    ).toBe(
      "Recommended follow-up: run openclaw --profile isolated doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.",
    );
  });
});

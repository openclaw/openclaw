import { describe, expect, it } from "vitest";
import {
  resolveCronAgentErrorClassification,
  resolveCronRunErrorReason,
} from "./run-error-reason.js";

describe("resolveCronRunErrorReason", () => {
  it("keeps permanent local script errors out of provider timeout classification", () => {
    expect(
      resolveCronRunErrorReason("cron script failed: request timed out", undefined, {
        kind: "permanent",
      }),
    ).toBeUndefined();
  });

  it("preserves genuine script timeout classification", () => {
    expect(
      resolveCronRunErrorReason("cron script failed", undefined, {
        kind: "reason",
        reason: "timeout",
      }),
    ).toBe("timeout");
  });

  it("preserves provider error classification for other cron failures", () => {
    expect(resolveCronRunErrorReason("internal_error from provider", "anthropic")).toBe("timeout");
  });
});

describe("cron terminal retry policy", () => {
  it.each([
    { reason: "aborted", expected: { kind: "reason", reason: "timeout" } },
    { reason: "timed_out", expected: { kind: "reason", reason: "timeout" } },
    { reason: "hard_timeout", expected: { kind: "reason", reason: "timeout" } },
    { reason: "cancelled", expected: { kind: "aborted" } },
    { reason: "superseded", expected: { kind: "aborted" } },
    { reason: "failed", expected: { kind: "reason", reason: "unknown" } },
  ] as const)("classifies $reason from facts, not display text", ({ reason, expected }) => {
    expect(resolveCronAgentErrorClassification({ reason, status: "error" })).toEqual(expected);
  });

  it("keeps revoked authority permanent while preserving hard timeout precedence", () => {
    expect(
      resolveCronAgentErrorClassification({
        reason: "aborted",
        status: "error",
        stopReason: "auth-revoked",
      }),
    ).toEqual({ kind: "reason", reason: "auth_permanent" });
    expect(
      resolveCronAgentErrorClassification({
        reason: "hard_timeout",
        status: "timeout",
        stopReason: "auth-revoked",
      }),
    ).toEqual({ kind: "reason", reason: "timeout" });
  });
});

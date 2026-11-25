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

it.each([
  { reason: "failed", expected: { kind: "permanent" } },
  { reason: "hard_timeout", expected: { kind: "reason", reason: "timeout" } },
  { reason: "cancelled", expected: { kind: "aborted" } },
  { reason: "superseded", expected: { kind: "aborted" } },
  {
    reason: "failed",
    stopReason: "auth-revoked",
    expected: { kind: "reason", reason: "auth_permanent" },
  },
] as const)(
  "keeps $reason/$stopReason precedence over a recorded configuration refusal",
  (test) => {
    expect(
      resolveCronAgentErrorClassification(
        {
          status: "error",
          reason: test.reason,
          ...("stopReason" in test ? { stopReason: test.stopReason } : {}),
        },
        undefined,
        { kind: "permanent" },
      ),
    ).toEqual(test.expected);
  },
);

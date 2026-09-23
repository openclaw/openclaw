import { describe, expect, it } from "vitest";
import { resolveQaDiagnosticHeartbeatTimings } from "./server-qa-diagnostic-timings.js";

describe("resolveQaDiagnosticHeartbeatTimings", () => {
  it("accepts a bounded timing override only inside a QA Gateway child", () => {
    expect(
      resolveQaDiagnosticHeartbeatTimings({
        OPENCLAW_QA_PARENT_PID: "123",
        QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: "30000",
      }),
    ).toEqual({ stuckSessionWarnMs: 15_000, stuckSessionAbortMs: 30_000 });
  });

  it.each([
    {},
    { QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: "30000" },
    {
      OPENCLAW_QA_PARENT_PID: "123",
      QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: "29999",
    },
    {
      OPENCLAW_QA_PARENT_PID: "123",
      QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: "not-a-number",
    },
  ])("rejects non-QA or unsafe overrides: %j", (env) => {
    expect(resolveQaDiagnosticHeartbeatTimings(env)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { resolveQaDiagnosticHeartbeatTimings } from "./server-qa-diagnostic-timings.js";

const qaEnv = {
  OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
  OPENCLAW_GATEWAY_HOST_LIFELINE: " stdin ",
  QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: "30000",
};

describe("resolveQaDiagnosticHeartbeatTimings", () => {
  it("accepts a bounded timing override only inside a QA Gateway child", () => {
    expect(resolveQaDiagnosticHeartbeatTimings(qaEnv)).toEqual({
      stuckSessionWarnMs: 15_000,
      stuckSessionAbortMs: 30_000,
    });
  });

  it.each([
    { ...qaEnv, OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined },
    { ...qaEnv, OPENCLAW_GATEWAY_HOST_LIFELINE: undefined },
    { ...qaEnv, QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: "29999" },
    { ...qaEnv, QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: "not-a-number" },
  ])("rejects non-QA or unsafe overrides: %j", (env) => {
    expect(resolveQaDiagnosticHeartbeatTimings(env)).toBeUndefined();
  });
});

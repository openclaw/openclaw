import { describe, expect, it } from "vitest";
import { resolveExecPolicyScopeSummary } from "../exec-approvals-effective.js";

describe("exec approvals effective security contracts", () => {
  it("host deny overrides requested full", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        version: 1,
        defaults: { security: "deny" },
      },
      scopeExecConfig: { security: "full" },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expect(summary.security).toMatchObject({
      requested: "full",
      host: "deny",
      effective: "deny",
      note: "stricter host security wins",
    });
  });

  it("host allowlist overrides requested full", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        version: 1,
        defaults: { security: "allowlist" },
      },
      scopeExecConfig: { security: "full" },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expect(summary.security).toMatchObject({
      requested: "full",
      host: "allowlist",
      effective: "allowlist",
      note: "stricter host security wins",
    });
  });

  it("requested allowlist remains when host full is looser", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        version: 1,
        defaults: { security: "full" },
      },
      scopeExecConfig: { security: "allowlist" },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expect(summary.security).toMatchObject({
      requested: "allowlist",
      host: "full",
      effective: "allowlist",
      note: "requested security applies",
    });
  });
});

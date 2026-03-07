import { describe, expect, it } from "vitest";
import { shouldRecoverInvalidConfigSnapshot } from "./snapshot-recovery.js";
import type { ConfigFileSnapshot } from "./types.js";

function makeSnapshot(overrides: Partial<ConfigFileSnapshot>): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}\n",
    parsed: {},
    resolved: {},
    valid: false,
    config: {},
    issues: [{ path: "gateway.mode", message: "invalid gateway mode" }],
    warnings: [],
    legacyIssues: [],
    ...overrides,
  };
}

describe("shouldRecoverInvalidConfigSnapshot", () => {
  it("allows recovery for parse failures", () => {
    const snapshot = makeSnapshot({
      issues: [{ path: "", message: "JSON5 parse failed: invalid character" }],
    });
    expect(shouldRecoverInvalidConfigSnapshot(snapshot)).toBe(true);
  });

  it("blocks recovery for missing env var substitution failures", () => {
    const snapshot = makeSnapshot({
      issues: [
        {
          path: "",
          message:
            'Missing env var "OPENCLAW_GATEWAY_TOKEN" referenced at config path: gateway.token',
        },
      ],
    });
    expect(shouldRecoverInvalidConfigSnapshot(snapshot)).toBe(false);
  });

  it("allows recovery for schema validation failures", () => {
    const snapshot = makeSnapshot({
      issues: [{ path: "gateway.mode", message: "Invalid enum value" }],
    });
    expect(shouldRecoverInvalidConfigSnapshot(snapshot)).toBe(true);
  });

  it("blocks recovery for include file read failures", () => {
    const snapshot = makeSnapshot({
      issues: [
        {
          path: "",
          message:
            "Failed to read include file: ./secrets.json (resolved: /home/user/.openclaw/secrets.json)",
        },
      ],
    });
    expect(shouldRecoverInvalidConfigSnapshot(snapshot)).toBe(false);
  });

  it("blocks recovery for include path escape errors", () => {
    const snapshot = makeSnapshot({
      issues: [
        {
          path: "",
          message:
            "Include path escapes config directory: ../../etc/passwd (root: /home/user/.openclaw)",
        },
      ],
    });
    expect(shouldRecoverInvalidConfigSnapshot(snapshot)).toBe(false);
  });
});

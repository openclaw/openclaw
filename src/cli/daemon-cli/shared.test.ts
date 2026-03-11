import { describe, expect, it } from "vitest";
import { theme } from "../../terminal/theme.js";
import { redactSensitiveDaemonEnv, resolveRuntimeStatusColor } from "./shared.js";

describe("resolveRuntimeStatusColor", () => {
  it("maps known runtime states to expected theme colors", () => {
    expect(resolveRuntimeStatusColor("running")).toBe(theme.success);
    expect(resolveRuntimeStatusColor("stopped")).toBe(theme.error);
    expect(resolveRuntimeStatusColor("unknown")).toBe(theme.muted);
  });

  it("falls back to warning color for unexpected states", () => {
    expect(resolveRuntimeStatusColor("degraded")).toBe(theme.warn);
    expect(resolveRuntimeStatusColor(undefined)).toBe(theme.muted);
  });
});

describe("redactSensitiveDaemonEnv", () => {
  it("redacts sensitive env keys so they are not exposed in status output", () => {
    const env = {
      OPENCLAW_NODE_HEADERS: '{"CF-Access-Client-Secret":"secret"}',
      OPENCLAW_GATEWAY_TOKEN: "token",
      OPENCLAW_STATE_DIR: "/home/user/.openclaw",
    };
    const out = redactSensitiveDaemonEnv(env);
    expect(out.OPENCLAW_NODE_HEADERS).toBe("[redacted]");
    expect(out.OPENCLAW_GATEWAY_TOKEN).toBe("[redacted]");
    expect(out.OPENCLAW_STATE_DIR).toBe("/home/user/.openclaw");
  });

  it("returns empty object for undefined env", () => {
    expect(redactSensitiveDaemonEnv(undefined)).toEqual({});
  });
});

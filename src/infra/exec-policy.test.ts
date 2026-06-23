import { describe, expect, it } from "vitest";
import { applyExecPolicyLayer } from "./exec-policy.js";

describe("applyExecPolicyLayer", () => {
  it("preserves caller fields when applying a mode layer", () => {
    const result = applyExecPolicyLayer(
      {
        ask: "on-miss" as const,
        host: "node",
        security: "allowlist" as const,
      },
      { mode: "full" },
    );

    expect(result).toEqual({
      ask: "off",
      autoReview: false,
      host: "node",
      mode: "full",
      security: "full",
    });
  });

  it("preserves inherited mode when applying explicit policy fields by default", () => {
    const result = applyExecPolicyLayer(
      {
        ask: "on-miss" as const,
        host: "node",
        mode: "auto" as const,
        security: "allowlist" as const,
      },
      { security: "deny" },
    );

    expect(result).toEqual({
      ask: "on-miss",
      host: "node",
      mode: "auto",
      security: "deny",
    });
  });

  it("clears stale inherited mode when legacy config layers request clearing", () => {
    const result = applyExecPolicyLayer(
      {
        ask: "on-miss" as const,
        host: "node",
        mode: "auto" as const,
        security: "allowlist" as const,
      },
      { security: "deny" },
      { clearModeOnLegacyPolicy: true },
    );

    expect(result).toEqual({
      ask: "on-miss",
      host: "node",
      security: "deny",
    });
  });
});

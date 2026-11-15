import { describe, expect, it } from "vitest";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../infra/update-run-timeouts.js";
import { resolveGatewayStartupTiming } from "./gateway-startup-timing.js";

describe("Gateway cold-start budgets", () => {
  it("reserves three update steps for Windows activation, loading, and readiness", () => {
    expect(resolveGatewayStartupTiming("win32").deadlineMs).toBe(
      3 * DEFAULT_UPDATE_STEP_TIMEOUT_MS,
    );
  });

  it.each([
    ["win32", 90],
    ["linux", 5],
  ] as const)("observes update startup for the %s floor of %i minutes", (platform, minutes) => {
    expect(resolveGatewayStartupTiming(platform, { migrationLeaseMs: 5 * 60_000 })).toMatchObject({
      deadlineMs: minutes * 60_000,
      derivation: `${minutes * 60_000}ms startup floor`,
    });
  });

  it("lets an explicit per-step timeout override the implicit Windows bounds", () => {
    expect(
      resolveGatewayStartupTiming("win32", {
        timeoutMs: 1_000,
        migrationLeaseMs: 5 * 60_000,
      }),
    ).toMatchObject({ deadlineMs: 1_000, derivation: "explicit --timeout" });
  });
});

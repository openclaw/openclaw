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
    { startupMinutes: 5, budgetMinutes: 90 },
    { startupMinutes: 10, budgetMinutes: 100 },
    { startupMinutes: 15, budgetMinutes: 120 },
  ])(
    "bounds a $startupMinutes-minute canary to $budgetMinutes minutes",
    ({ startupMinutes, budgetMinutes }) => {
      for (const previousGateway of [false, true]) {
        const timing = resolveGatewayStartupTiming("win32", {
          migrationLeaseMs: 5 * 60_000,
          observedStartupMs: startupMinutes * 60_000,
          previousGateway,
        });
        expect(timing.deadlineMs).toBe(budgetMinutes * 60_000);
        expect(timing.deadlineMs).toBeGreaterThanOrEqual(3 * DEFAULT_UPDATE_STEP_TIMEOUT_MS);
        expect(timing.deadlineMs).toBeLessThanOrEqual(4 * DEFAULT_UPDATE_STEP_TIMEOUT_MS);
        expect(timing.derivation).toBe(
          `min(${4 * DEFAULT_UPDATE_STEP_TIMEOUT_MS}ms, max(${3 * DEFAULT_UPDATE_STEP_TIMEOUT_MS}ms, canary startup ${startupMinutes * 60_000}ms × 10))`,
        );
      }
    },
  );

  it("lets an explicit per-step timeout override the implicit Windows bounds", () => {
    expect(
      resolveGatewayStartupTiming("win32", {
        timeoutMs: 1_000,
        migrationLeaseMs: 5 * 60_000,
        observedStartupMs: 15 * 60_000,
        previousGateway: true,
      }),
    ).toMatchObject({ deadlineMs: 1_000, derivation: "explicit --timeout" });
  });

  it("retains the non-Windows previous-Gateway cap and uncapped activation observation", () => {
    const update = { migrationLeaseMs: 5 * 60_000, observedStartupMs: 10 * 60_000 };
    expect(
      resolveGatewayStartupTiming("linux", { ...update, previousGateway: true }).deadlineMs,
    ).toBe(60 * 60_000);
    expect(resolveGatewayStartupTiming("linux", update).deadlineMs).toBe(100 * 60_000);
  });
});

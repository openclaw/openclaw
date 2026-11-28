// Readiness plan tests cover the skip-health, session-gateway and startup-budget decisions.
import { describe, expect, it } from "vitest";
import { planGatewayReadiness } from "./setup.finalize-gateway-readiness.js";

describe("planGatewayReadiness", () => {
  it.each([false, undefined] as const)(
    "awaits readiness for every service when skipHealth is %s",
    (skipHealth) => {
      expect(planGatewayReadiness({ status: "ready" }, skipHealth, false)).toEqual({
        awaitReadiness: true,
        probeOnce: false,
        startupBudget: true,
      });
    },
  );

  it("probes once under --skip-health when this run started nothing", () => {
    expect(planGatewayReadiness({ status: "ready", action: "reused" }, true, false)).toEqual({
      awaitReadiness: false,
      probeOnce: true,
      startupBudget: false,
    });
  });

  it("still awaits a service installed by this run under --skip-health", () => {
    expect(planGatewayReadiness({ status: "ready", action: "installed" }, true, false)).toEqual({
      awaitReadiness: true,
      probeOnce: false,
      startupBudget: true,
    });
  });

  it("awaits the session gateway under --skip-health", () => {
    expect(planGatewayReadiness({ status: "ready" }, true, true)).toEqual({
      awaitReadiness: true,
      probeOnce: false,
      startupBudget: true,
    });
  });
});

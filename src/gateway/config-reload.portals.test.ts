import { describe, expect, it } from "vitest";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";

describe("portal ingress reload ownership", () => {
  it.each([
    "gateway.portals",
    "gateway.portals.ingress",
    "gateway.portals.ingress.domain",
    "gateway.portals.ingress.port",
  ])("restarts listener ownership for %s", (path) => {
    const plan = buildGatewayReloadPlan([path]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain(path);
  });
});

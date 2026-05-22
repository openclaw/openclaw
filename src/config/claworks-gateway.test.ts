import { describe, expect, it } from "vitest";
import {
  CLAWORKS_STANDARD_GATEWAY_PORT,
  coerceClaworksGatewayPort,
  claworksGatewayPortConflict,
  formatClaworksReservedPortConfigSetError,
  repairClaworksGatewayPortInConfig,
} from "./claworks-gateway.js";

describe("claworks-gateway", () => {
  const claworksEnv = { CLAWORKS_PRODUCT: "1" };

  it("coerces OpenClaw reserved port to ClaWorks default", () => {
    expect(coerceClaworksGatewayPort(18_789, claworksEnv)).toBe(CLAWORKS_STANDARD_GATEWAY_PORT);
    expect(coerceClaworksGatewayPort(18_900, claworksEnv)).toBe(18_900);
    expect(coerceClaworksGatewayPort(18_789, {})).toBe(18_789);
  });

  it("detects and repairs config port conflicts", () => {
    const cfg = { gateway: { mode: "local", port: 18_789 } };
    expect(claworksGatewayPortConflict(cfg, claworksEnv)).toBe(true);
    expect(repairClaworksGatewayPortInConfig(cfg, claworksEnv).gateway?.port).toBe(
      CLAWORKS_STANDARD_GATEWAY_PORT,
    );
  });

  it("rejects config set to OpenClaw reserved port", () => {
    expect(formatClaworksReservedPortConfigSetError("gateway.port", 18_789, claworksEnv)).toContain(
      "18800",
    );
    expect(
      formatClaworksReservedPortConfigSetError("gateway.port", 18_900, claworksEnv),
    ).toBeNull();
  });
});

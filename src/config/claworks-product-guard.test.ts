import { describe, expect, it } from "vitest";
import { shouldBlockOpenClawGatewayLifecycleArgv } from "./claworks-product-guard.js";

describe("shouldBlockOpenClawGatewayLifecycleArgv", () => {
  it("blocks gateway install from openclaw entry in ClaWorks repo", () => {
    expect(
      shouldBlockOpenClawGatewayLifecycleArgv(["gateway", "install"], {
        isClaworksRepo: true,
        claworksProduct: false,
      }),
    ).toBe(true);
  });

  it("allows gateway status", () => {
    expect(
      shouldBlockOpenClawGatewayLifecycleArgv(["gateway", "status"], {
        isClaworksRepo: true,
        claworksProduct: false,
      }),
    ).toBe(false);
  });

  it("allows when CLAWORKS_PRODUCT is set", () => {
    expect(
      shouldBlockOpenClawGatewayLifecycleArgv(["gateway", "install"], {
        isClaworksRepo: true,
        claworksProduct: true,
      }),
    ).toBe(false);
  });
});

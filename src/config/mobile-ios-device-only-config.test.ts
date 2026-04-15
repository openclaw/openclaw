import { describe, expect, it } from "vitest";
import { MOBILE_IOS_DEVICE_ONLY_CONFIG } from "./mobile-ios-device-only-config.js";

describe("MOBILE_IOS_DEVICE_ONLY_CONFIG", () => {
  it("uses local loopback gateway defaults with an iOS-only node platform allowlist", () => {
    expect(MOBILE_IOS_DEVICE_ONLY_CONFIG.gateway?.mode).toBe("local");
    expect(MOBILE_IOS_DEVICE_ONLY_CONFIG.gateway?.bind).toBe("loopback");
    expect(MOBILE_IOS_DEVICE_ONLY_CONFIG.gateway?.nodes?.platformAllowlist).toEqual([
      "ios",
      "ipados",
    ]);
  });
});

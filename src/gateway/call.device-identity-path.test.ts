import { describe, expect, it } from "vitest";
import { resolveDeviceIdentityPathFromConfig } from "./call.js";

describe("resolveDeviceIdentityPathFromConfig", () => {
  it("derives a stable identity path from config path", () => {
    expect(resolveDeviceIdentityPathFromConfig("/data/.openclaw/openclaw.json")).toBe(
      "/data/.openclaw/identity/device.json",
    );
  });

  it("returns undefined when config path is missing", () => {
    expect(resolveDeviceIdentityPathFromConfig(undefined)).toBeUndefined();
    expect(resolveDeviceIdentityPathFromConfig("   ")).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  isPhysicalDeviceReachableUrl,
  toChatUrl,
} from "../../scripts/dev/control-ui-mobile-safari-smoke.js";

describe("control-ui mobile Safari smoke URL handling", () => {
  it("launches chat through the mobile rescue refresh path while preserving auth fragments", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T14:40:00.000Z"));

    expect(toChatUrl("https://openclaw.tail.example/#token=secret&session=main")).toBe(
      "https://openclaw.tail.example/chat?__openclaw_mobile_rescue=1779201600000#token=secret&session=main",
    );
    vi.useRealTimers();
  });

  it("rejects Mac-only loopback URLs for physical iPhone proof", () => {
    expect(isPhysicalDeviceReachableUrl("http://127.0.0.1:18789/chat")).toBe(false);
    expect(isPhysicalDeviceReachableUrl("http://localhost:18789/chat")).toBe(false);
    expect(isPhysicalDeviceReachableUrl("http://0.0.0.0:18789/chat")).toBe(false);
    expect(isPhysicalDeviceReachableUrl("https://openclaw.tail.example/chat")).toBe(true);
    expect(isPhysicalDeviceReachableUrl("http://192.168.1.25:18789/chat")).toBe(true);
  });
});

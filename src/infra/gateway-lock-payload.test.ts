import { expect, it } from "vitest";
import { gatewayLockOwnerIsSameHostWindowsNamespace } from "./gateway-lock-payload.js";

const WINDOWS_BOOT = {
  platform: "win32" as const,
  host: "test-host",
  identity: "2026-10-18T00:00:00.0000000Z",
};

it("matches only a same-host Windows owner namespace", () => {
  expect(gatewayLockOwnerIsSameHostWindowsNamespace(WINDOWS_BOOT, WINDOWS_BOOT)).toBe(true);
  expect(
    gatewayLockOwnerIsSameHostWindowsNamespace(
      { platform: "linux", host: "test-host", identity: WINDOWS_BOOT.identity, pidNsInode: "1" },
      WINDOWS_BOOT,
    ),
  ).toBe(false);
  expect(
    gatewayLockOwnerIsSameHostWindowsNamespace(
      { ...WINDOWS_BOOT, host: "other-host.invalid" },
      WINDOWS_BOOT,
    ),
  ).toBe(false);
  expect(gatewayLockOwnerIsSameHostWindowsNamespace(undefined, WINDOWS_BOOT)).toBe(false);
  expect(gatewayLockOwnerIsSameHostWindowsNamespace(WINDOWS_BOOT, null)).toBe(false);
});

import { describe, expect, it } from "vitest";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import {
  expectCurrent,
  restoreFixture,
  withRecovery,
} from "./operator-run-recovery.test-support.js";

describe("native UI operator recovery", () => {
  it.each([
    "openclaw-control-ui",
    "openclaw-macos",
    "openclaw-linux",
    "openclaw-ios",
    "openclaw-android",
  ] as const)(
    "keeps admitted %s delegation after revocation and refuses the next restoration",
    (id) =>
      withRecovery(
        async (fixture) => {
          using restored = await restoreFixture(fixture);
          expectCurrent(restored.authority);
          expect(
            (await rotateDeviceToken({ deviceId: "recovery-device", role: "operator" })).ok,
          ).toBe(true);
          invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
          expectCurrent(restored.authority);
          await expect(fixture.restore()).rejects.toThrow();
        },
        { clientInfo: { id, mode: "ui" } },
      ),
  );
});

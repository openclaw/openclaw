import { describe, expect, it } from "vitest";
import { revokeDeviceToken, rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { removePairedDevice } from "../infra/device-pairing.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import {
  expectCurrent,
  pairedOperator,
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
          expect(restored.automationAdmin).toBe(true);
          expect(restored.controlUiAdmin).toBe(id === "openclaw-control-ui");
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
  it.each(["remove", "revoke", "remove-without-token"] as const)(
    "checks a paired tokenless proxy device only at the next start (%s)",
    (change) => {
      const device = pairedOperator();
      if (change === "remove-without-token") {
        delete device.tokens;
      }
      return withRecovery(
        async (fixture) => {
          expect(fixture.snapshot.device).toMatchObject({ deviceId: "recovery-device" });
          using admitted = await restoreFixture(fixture);
          if (change === "revoke") {
            await revokeDeviceToken({ deviceId: "recovery-device", role: "operator" });
          } else {
            await removePairedDevice("recovery-device");
          }
          expectCurrent(admitted.authority);
          await expect(fixture.restore()).rejects.toThrow(
            GatewayOperatorRecoveryAuthorizationError,
          );
        },
        { device, tokenlessDevice: true },
      );
    },
  );
  it("preserves legacy browser grants but does not upgrade legacy native sources", () =>
    withRecovery(async (fixture) => {
      if (fixture.snapshot.sourceIngress === "principal") {
        throw new Error("Expected authenticated UI handshake snapshot");
      }
      const { automationAdmin: _admin, ...legacy } = fixture.snapshot;
      const restore = (controlUiAdmin: boolean) =>
        restoreGatewayOperatorSource({
          snapshot: { ...legacy, controlUiAdmin },
          context: fixture.context,
          assertCurrent: () => {},
        });
      const browser = await restore(true);
      const native = await restore(false);
      try {
        expect(browser.automationAdmin).toBe(true);
        expect(native.automationAdmin).toBe(false);
      } finally {
        browser.release();
        native.release();
      }
    }));
});

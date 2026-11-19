import { describe, expect, it } from "vitest";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
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
          expect(restored.automationAdmin).toBe(true);
          expect(restored.controlUiAdmin).toBe(id === "openclaw-control-ui");
          expectCurrent(restored.authority);
          expect(
            (await rotateDeviceToken({ deviceId: "recovery-device", role: "operator" })).ok,
          ).toBe(true);
          invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
          expectCurrent(restored.authority);
          expect(restored.authority.reauthorize).toThrow();
          expectCurrent(restored.authority);
          await expect(fixture.restore()).rejects.toThrow();
        },
        { clientInfo: { id, mode: "ui" } },
      ),
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
          target: fixture.target,
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

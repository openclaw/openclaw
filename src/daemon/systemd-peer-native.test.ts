import { expect, it } from "vitest";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";
import { openSystemdBroker } from "./systemd-peer-native.js";

it("checks inherited update authority before loading or opening a native transport", async () => {
  const denied = new Error("original update grant retired");
  let active = true;
  let transportFailure: unknown;
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!active) {
          throw denied;
        }
      },
      async () => {
        active = false;
        try {
          await openSystemdBroker(
            "unix:path=/nonexistent-openclaw-test/bus",
            performance.now() + 100,
          );
        } catch (error) {
          transportFailure = error;
        }
      },
    ),
  ).rejects.toBe(denied);
  expect(transportFailure).toBe(denied);
});

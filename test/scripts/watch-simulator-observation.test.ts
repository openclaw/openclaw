import { describe, expect, it } from "vitest";
import { observeOwnedWatchSimulator } from "../../scripts/lib/watch-simulator-observation.mts";

describe("owned Watch simulator observations", () => {
  const watchRuntime = "com.apple.CoreSimulator.SimRuntime.watchOS-27-0";
  const phoneRuntime = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
  const deviceType = "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-12-46mm";
  const watch = {
    udid: "owned-watch",
    state: "Booting",
    isAvailable: true,
    deviceTypeIdentifier: deviceType,
    name: "private simulator name",
    dataPath: "/private/fixture/device",
  };
  const phone = { udid: "companion", state: "Booted", isAvailable: true };

  it.each([false, true])(
    "reports exact owned state with paired=%s without private inventory",
    (paired) => {
      expect(
        observeOwnedWatchSimulator(
          {
            devices: {
              [watchRuntime]: [watch, { ...watch, udid: "other-watch", state: "Booted" }],
              [phoneRuntime]: [phone],
            },
            pairs: paired ? { privatePair: { watch, phone } } : {},
          },
          watch.udid,
        ),
      ).toEqual({
        ownedMatches: 1,
        state: "Booting",
        available: true,
        runtime: watchRuntime,
        deviceType,
        pairMatches: paired ? 1 : 0,
        companionState: paired ? "Booted" : null,
        bootedWatches: 1,
        bootedIOSDevices: 1,
      });
    },
  );

  it.each(["missing", "duplicate", "unknown-state", "private-identifiers"])(
    "does not turn %s observations into a known device state",
    (scenario) => {
      const devices =
        scenario === "missing"
          ? []
          : scenario === "duplicate"
            ? [watch, watch]
            : [
                {
                  ...watch,
                  state: scenario === "unknown-state" ? "private diagnostic" : watch.state,
                  deviceTypeIdentifier:
                    scenario === "private-identifiers" ? "/private/device-type" : deviceType,
                },
              ];
      const result = observeOwnedWatchSimulator(
        {
          devices: {
            [scenario === "private-identifiers" ? "/private/runtime" : watchRuntime]: devices,
          },
          pairs: {},
        },
        watch.udid,
      );
      expect(result.state).toBe(scenario === "private-identifiers" ? "Booting" : null);
      expect(result.companionState).toBeNull();
      if (scenario === "private-identifiers") {
        expect(result.runtime).toBeNull();
        expect(result.deviceType).toBeNull();
      }
      expect(JSON.stringify(result)).not.toMatch(/private|owned-watch|"companion"/);
    },
  );
});

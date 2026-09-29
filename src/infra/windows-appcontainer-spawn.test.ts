import { describe, expect, it } from "vitest";
import {
  AppContainerSpawnUnsupportedError,
  libuvNamesAppContainerPipes,
  resolveAppContainerSpawnSupport,
} from "./windows-appcontainer-spawn.js";

// Reading the token needs a real Windows AppContainer; these cases pin the
// decision taken from it, so they run on every OS.
describe("libuvNamesAppContainerPipes", () => {
  it("draws the line at libuv 1.53.0", () => {
    expect(libuvNamesAppContainerPipes("1.52.1")).toBe(false);
    expect(libuvNamesAppContainerPipes("1.51.0")).toBe(false);
    expect(libuvNamesAppContainerPipes("0.99.99")).toBe(false);
    expect(libuvNamesAppContainerPipes("1.53.0")).toBe(true);
    expect(libuvNamesAppContainerPipes("1.53.1")).toBe(true);
    expect(libuvNamesAppContainerPipes("1.60.0")).toBe(true);
    expect(libuvNamesAppContainerPipes("2.0.0")).toBe(true);
  });

  it("does not refuse a version it cannot read", () => {
    expect(libuvNamesAppContainerPipes("")).toBe(true);
    expect(libuvNamesAppContainerPipes("unknown")).toBe(true);
  });
});

describe("resolveAppContainerSpawnSupport", () => {
  it("refuses only inside a Windows AppContainer with libuv below 1.53.0", () => {
    const refused = resolveAppContainerSpawnSupport({
      platform: "win32",
      inAppContainer: true,
      uvVersion: "1.52.1",
    });
    expect(refused).toMatchObject({ supported: false, uvVersion: "1.52.1" });
    expect(refused.supported ? "" : refused.message).toContain("libuv 1.52.1");
    expect(refused.supported ? "" : refused.message).toContain("1.53.0 or later");
  });

  it.each([
    { platform: "win32", inAppContainer: false, uvVersion: "1.52.1" },
    { platform: "win32", inAppContainer: true, uvVersion: "1.53.0" },
    { platform: "linux", inAppContainer: true, uvVersion: "1.52.1" },
    { platform: "win32", inAppContainer: true, uvVersion: undefined },
  ] as const)("allows spawns for %o", (params) => {
    expect(resolveAppContainerSpawnSupport(params)).toEqual({ supported: true });
  });

  it("names its error so callers can tell it from a failed command", () => {
    const error = new AppContainerSpawnUnsupportedError("no");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AppContainerSpawnUnsupportedError");
    expect(error.code).toBe("OPENCLAW_APPCONTAINER_SPAWN_UNSUPPORTED");
  });
});

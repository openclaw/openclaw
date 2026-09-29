import { describe, expect, it } from "vitest";
import { assertWindowsChildPipesSupported } from "./windows-appcontainer-spawn-guard.js";

describe("assertWindowsChildPipesSupported", () => {
  it("throws inside an AppContainer with libuv below 1.53", () => {
    expect(() =>
      assertWindowsChildPipesSupported({
        platform: "win32",
        libuvVersion: "1.52.1",
        isAppContainer: () => true,
      }),
    ).toThrow(/libuv 1\.52\.1.*AppContainer.*1\.53\.0 or later/);
  });

  it.each([
    { platform: "win32", libuvVersion: "1.53.0", inside: true },
    { platform: "win32", libuvVersion: "1.52.1", inside: false },
    { platform: "linux", libuvVersion: "1.52.1", inside: true },
  ] as const)("allows %o", ({ platform, libuvVersion, inside }) => {
    expect(() =>
      assertWindowsChildPipesSupported({ platform, libuvVersion, isAppContainer: () => inside }),
    ).not.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const { readToken, loadToken, debug } = vi.hoisted(() => ({
  readToken: vi.fn(),
  loadToken: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return Object.assign({}, actual, {
    createRequire: (filename: string | URL) => {
      const require = actual.createRequire(filename);
      return Object.assign(
        (id: string) => (id === "@openclaw/proc-safe/windows-token" ? loadToken(id) : require(id)),
        require,
      );
    },
  });
});
vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ debug }),
}));

beforeEach(() => {
  vi.resetModules();
  readToken.mockReset().mockReturnValue(null);
  loadToken.mockReset().mockReturnValue({ readCurrentAppContainerSid: readToken });
  debug.mockClear();
});
afterEach(() => vi.restoreAllMocks());

async function guard(platform: NodeJS.Platform, uv = "1.52.1") {
  mockProcessPlatform(platform);
  vi.spyOn(process, "versions", "get").mockReturnValue({ ...process.versions, uv });
  return await import("./windows-appcontainer-spawn.js");
}

describe("AppContainer child pipes", () => {
  it("does not load the token reader outside Windows", async () => {
    const { assertAppContainerSpawnSupported } = await guard("linux");
    assertAppContainerSpawnSupported();
    expect(loadToken).not.toHaveBeenCalled();
  });

  it.each(["1.51.0", "1.52.1"])(
    "refuses old libuv %s with a named actionable error",
    async (uv) => {
      readToken.mockReturnValue("S-1-15-2-123");
      const { assertAppContainerSpawnSupported, AppContainerSpawnUnsupportedError } = await guard(
        "win32",
        uv,
      );
      expect(assertAppContainerSpawnSupported).toThrow(AppContainerSpawnUnsupportedError);
      expect(assertAppContainerSpawnSupported).toThrow(`libuv ${uv}`);
      try {
        assertAppContainerSpawnSupported();
      } catch (error) {
        expect(error).toMatchObject({
          name: "AppContainerSpawnUnsupportedError",
          code: "APPCONTAINER_SPAWN_UNSUPPORTED",
        });
      }
      expect(readToken).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["1.53.0", "1.54.1", "2.0.0"])("allows fixed libuv %s inside a container", async (uv) => {
    readToken.mockReturnValue("S-1-15-2-123");
    const { assertAppContainerSpawnSupported } = await guard("win32", uv);
    expect(assertAppContainerSpawnSupported).not.toThrow();
  });

  it("allows explicit stdio without pipes even inside an affected container", async () => {
    readToken.mockReturnValue("S-1-15-2-123");
    const { assertAppContainerSpawnSupported } = await guard("win32");
    for (const stdio of [
      "ignore",
      "inherit",
      ["ignore", "inherit", 2],
    ] satisfies import("node:child_process").StdioOptions[]) {
      expect(() => assertAppContainerSpawnSupported(stdio)).not.toThrow();
    }
    expect(readToken).not.toHaveBeenCalled();
    expect(() => assertAppContainerSpawnSupported([-1, "ignore", "ignore"])).toThrow(
      "AppContainer: libuv 1.52.1",
    );
  });

  it("caches a Windows non-container result", async () => {
    const { assertAppContainerSpawnSupported } = await guard("win32");
    assertAppContainerSpawnSupported();
    assertAppContainerSpawnSupported();
    expect(readToken).toHaveBeenCalledTimes(1);
  });

  it("allows spawning and logs once when the token probe fails", async () => {
    readToken.mockImplementation(() => {
      throw new Error("probe unavailable");
    });
    const { assertAppContainerSpawnSupported } = await guard("win32");
    expect(assertAppContainerSpawnSupported).not.toThrow();
    expect(assertAppContainerSpawnSupported).not.toThrow();
    await vi.dynamicImportSettled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(readToken).toHaveBeenCalledTimes(1);
  });
});

describe("spawn owners", () => {
  it("refuses the synchronous console probe before child_process", async () => {
    const { resolveWindowsConsoleEncoding } = await import("./windows-encoding.js");
    readToken.mockReturnValue("S-1-15-2-123");
    await guard("win32");
    expect(resolveWindowsConsoleEncoding).toThrow("AppContainer: libuv 1.52.1");
  });
});

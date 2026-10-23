import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  readToken.mockReset().mockReturnValue("S-1-15-2-123");
  loadToken.mockReset().mockReturnValue({ readCurrentAppContainerSid: readToken });
  debug.mockClear();
});
afterEach(() => vi.restoreAllMocks());

async function guard(uv = "1.52.1", platform: NodeJS.Platform = "win32") {
  mockProcessPlatform(platform);
  vi.spyOn(process, "versions", "get").mockReturnValue({ ...process.versions, uv });
  const {
    assertAppContainerSpawnSupported: assert,
    AppContainerSpawnUnsupportedError: Unsupported,
  } = await import("./windows-appcontainer-spawn.js");
  return { assert, Unsupported };
}

it("does not load the token reader outside Windows", async () => {
  const { assert } = await guard(undefined, "linux");
  assert();
  expect(loadToken).not.toHaveBeenCalled();
});

it.each(["1.51.0", "1.52.1"])("refuses old libuv %s with a named actionable error", async (uv) => {
  const { assert, Unsupported } = await guard(uv);
  expect(assert).toThrow(Unsupported);
  expect(assert).toThrow(
    expect.objectContaining({
      name: "AppContainerSpawnUnsupportedError",
      code: "APPCONTAINER_SPAWN_UNSUPPORTED",
      message: expect.stringContaining(`libuv ${uv}`),
    }),
  );
  expect(readToken).toHaveBeenCalledTimes(1);
});

it.each(["1.53.0", "1.54.1", "2.0.0"])("allows fixed libuv %s inside a container", async (uv) => {
  const { assert } = await guard(uv);
  expect(assert).not.toThrow();
});

it("allows explicit stdio without pipes even inside an affected container", async () => {
  const { assert } = await guard();
  for (const stdio of [
    "ignore",
    "inherit",
    ["ignore", "inherit", 2],
  ] satisfies import("node:child_process").StdioOptions[]) {
    expect(() => assert(stdio)).not.toThrow();
  }
  expect(readToken).not.toHaveBeenCalled();
  expect(() => assert([-1, "ignore", "ignore"])).toThrow("AppContainer: libuv 1.52.1");
});

it.each([false, true])("caches an allowed token probe (failed=%s)", async (failed) => {
  const { assert } = await guard();
  readToken.mockImplementation(() => {
    if (failed) {
      throw new Error("probe unavailable");
    }
    return null;
  });
  expect(assert).not.toThrow();
  expect(assert).not.toThrow();
  await vi.dynamicImportSettled();
  expect(debug).toHaveBeenCalledTimes(failed ? 1 : 0);
  expect(readToken).toHaveBeenCalledTimes(1);
});

it("refuses the synchronous console probe before child_process", async () => {
  const { resolveWindowsConsoleEncoding } = await import("./windows-encoding.js");
  await guard();
  expect(resolveWindowsConsoleEncoding).toThrow("AppContainer: libuv 1.52.1");
});

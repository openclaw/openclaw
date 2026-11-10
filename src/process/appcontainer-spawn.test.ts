import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppContainerSpawnUnsupportedError } from "../infra/windows-appcontainer-spawn.js";
import {
  readWindowsListeningPidsResultSync,
  readWindowsPortUsageSync,
  readWindowsProcessArgsResultSync,
} from "../infra/windows-port-pids.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { spawnCommandWithInvocation } from "./exec-spawn.js";
import { spawnProcess, spawnAndWait } from "./spawn-utils.js";

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return Object.assign({}, actual, {
    createRequire: (filename: string | URL) => {
      const require = actual.createRequire(filename);
      return Object.assign(
        (id: string) =>
          id === "@openclaw/proc-safe/windows-token"
            ? { readCurrentAppContainerSid: () => "S-1-15-2-123" }
            : require(id),
        require,
      );
    },
  });
});

beforeEach(() => {
  mockProcessPlatform("win32");
  vi.spyOn(process, "versions", "get").mockReturnValue({ ...process.versions, uv: "1.52.1" });
});
afterEach(() => vi.restoreAllMocks());

describe("AppContainer spawn boundaries", () => {
  it("refuses a direct pipe spawn before Node can create the child", () => {
    expect(() => spawnProcess("guard-must-refuse", [], { stdio: "pipe" })).toThrow(
      AppContainerSpawnUnsupportedError,
    );
  });

  it.each([
    () => readWindowsListeningPidsResultSync(18789),
    () => readWindowsPortUsageSync(18789, 1000),
    () => readWindowsProcessArgsResultSync(process.pid),
  ])("refuses synchronous service probes before Node can create child pipes", (probe) => {
    expect(probe).toThrow(AppContainerSpawnUnsupportedError);
  });

  it("refuses custom supervisor transports before their launch callback", async () => {
    const spawnImpl = vi.fn();
    await expect(
      spawnAndWait({ argv: ["guard-must-refuse"], options: { stdio: "pipe" }, spawnImpl }),
    ).rejects.toThrow(AppContainerSpawnUnsupportedError);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { stdio: "ignore", node: true },
    { stdio: "inherit", ipcInput: "hello" },
    { stdio: "ignore", gracefulCancel: true },
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    { stdio: "inherit", input: "hello" },
    { stdio: "inherit", inputFile: "input.txt" },
  ] as const)("refuses an Execa command that creates pipes: %j", (options) => {
    expect(() => spawnCommandWithInvocation(["guard-must-refuse"], options)).toThrow(
      AppContainerSpawnUnsupportedError,
    );
  });
});

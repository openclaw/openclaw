import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const { provider, commandMetadata } = vi.hoisted(() => ({
  provider: vi.fn(),
  commandMetadata: vi.fn(),
}));
vi.mock("./process-cwd-provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process-cwd-provider.js")>()),
  readProviderProcessWorkingDirectory: provider,
}));
vi.mock("../process/supervisor/service-child-group-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../process/supervisor/service-child-group-ownership.js")
  >()),
  readLinuxProcessCommandMetadata: commandMetadata,
}));
import { readProcessWorkingDirectories } from "./gateway-process-argv.js";

const own = {
  startTicks: "42",
  ppid: 1,
  uids: [999, 999, 999, 999],
  gids: [983, 983, 983, 983],
} as const;
const command = { argv: ["/usr/bin/ssh-agent"], uid: 999, generation: own };
beforeEach(() => {
  mockProcessPlatform("linux");
  vi.spyOn(process, "getuid").mockReturnValue(999);
  vi.spyOn(fs, "readlinkSync").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });
  provider.mockReset().mockReturnValue(undefined);
  commandMetadata.mockReset().mockReturnValue(command);
});
afterEach(() => vi.restoreAllMocks());

it("does not start provider clients for many root or foreign credential tuples", () => {
  const pids = Array.from({ length: 100 }, (_, index) => index + 10);
  const commands = new Map(
    pids.map((pid) => [
      pid,
      {
        ...command,
        generation: {
          ...own,
          uids: [
            pid % 2 ? 0 : 1000,
            pid % 2 ? 0 : 1000,
            pid % 2 ? 0 : 1000,
            pid % 2 ? 0 : 1000,
          ] as const,
        },
      },
    ]),
  );
  expect(readProcessWorkingDirectories(pids, commands, Date.now() + 1000).size).toBe(0);
  expect(provider).not.toHaveBeenCalled();
});

it("shares the census deadline and starts no later fallback after it expires", () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  provider.mockImplementation(() => {
    now = 1100;
    return undefined;
  });
  expect(
    readProcessWorkingDirectories(
      [10, 11, 12],
      new Map([
        [10, command],
        [11, command],
        [12, command],
      ]),
      1100,
    ).size,
  ).toBe(0);
  expect(provider).toHaveBeenCalledExactlyOnceWith(10, own, 1100);
});

it("retains same-UID positive runtime cwd without rewriting it into a non-holder", () => {
  provider.mockReturnValue("/tmp/openclaw-update-runtime-Ab12Cd");
  expect(
    readProcessWorkingDirectories([10], new Map([[10, command]]), Date.now() + 1000).get(10),
  ).toBe("/tmp/openclaw-update-runtime-Ab12Cd");
});

it("leaves a refused same-UID cwd unavailable", () => {
  expect(
    readProcessWorkingDirectories([10], new Map([[10, command]]), Date.now() + 1000).has(10),
  ).toBe(false);
});

it("does not replace an already-readable retained-runtime cwd with provider evidence", () => {
  vi.mocked(fs.readlinkSync).mockReturnValue("/tmp/openclaw-update-runtime-Ab12Cd");
  expect(
    readProcessWorkingDirectories([10], new Map([[10, command]]), Date.now() + 1000).get(10),
  ).toBe("/tmp/openclaw-update-runtime-Ab12Cd");
  expect(provider).not.toHaveBeenCalled();
});

it("preserves native deleted retained cwd evidence without launching a provider", () => {
  vi.mocked(fs.readlinkSync).mockReturnValue("/tmp/openclaw-update-runtime-Ab12Cd (deleted)");
  expect(
    readProcessWorkingDirectories([10], new Map([[10, command]]), Date.now() + 1000).get(10),
  ).toBe("/tmp/openclaw-update-runtime-Ab12Cd (deleted)");
  expect(provider).not.toHaveBeenCalled();
});

it("refuses same-birth same-credential exec drift after the provider response", () => {
  provider.mockReturnValue("/ordinary");
  commandMetadata.mockReturnValueOnce(command).mockReturnValueOnce({
    ...command,
    argv: ["node", "/app/openclaw.mjs", "gateway"],
  });
  expect(() =>
    readProcessWorkingDirectories([10], new Map([[10, command]]), Date.now() + 1000),
  ).toThrow("process command is unavailable or changed");
  expect(provider).toHaveBeenCalledOnce();
});

it("refuses command drift before provider launch", () => {
  commandMetadata.mockReturnValue({ ...command, argv: ["node", "changed.js"] });
  expect(() =>
    readProcessWorkingDirectories([10], new Map([[10, command]]), Date.now() + 1000),
  ).toThrow("process command is unavailable or changed");
  expect(provider).not.toHaveBeenCalled();
});

it("refuses a changed runtime service marker", () => {
  const runtime = { ...command, argv: ["node", "service.js"] };
  provider.mockReturnValue("/ordinary");
  commandMetadata
    .mockReturnValueOnce(runtime)
    .mockReturnValueOnce({ ...runtime, serviceMarker: "openclaw" });
  expect(() =>
    readProcessWorkingDirectories([10], new Map([[10, runtime]]), Date.now() + 1000),
  ).toThrow("process command is unavailable or changed");
  expect(commandMetadata).toHaveBeenCalledWith(10, own, true, expect.any(Number));
});

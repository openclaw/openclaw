import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SpawnResult } from "../process/exec.js";
import { inspectPortUsage } from "./ports-inspect.js";

const runCommand = vi.hoisted(() =>
  vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(),
);
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: runCommand }));
vi.mock("./ports-lsof.js", () => ({ resolveLsofCommand: async () => "lsof" }));
vi.mock("./windows-install-roots.js", () => ({
  getWindowsSystem32ExePath: (name: string) => name,
  getWindowsPowerShellExePath: () => "powershell.exe",
  getWindowsWmicExePath: () => "wmic.exe",
}));

const originalPlatform = process.platform;
afterEach(() => {
  vi.restoreAllMocks();
  runCommand.mockReset();
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

function commandResult(stdout = "", code = 0): SpawnResult {
  return { stdout, stderr: "", code, signal: null, killed: false, termination: "exit" };
}

describe("port inspection cancellation", () => {
  it.each([
    { platform: "linux", command: "lsof", failure: false },
    { platform: "linux", command: "lsof", failure: true },
    { platform: "linux", command: "ps", failure: false },
    { platform: "win32", command: "netstat.exe", failure: false },
    { platform: "win32", command: "powershell.exe", failure: true },
  ])(
    "stops follow-up commands and binds after $platform $command completes late (failure=$failure)",
    async ({ platform, command, failure }) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const entered = createDeferred();
      const release = createDeferred<SpawnResult>();
      const controller = new AbortController();
      const bind = vi.spyOn(net, "createServer").mockImplementation(() => {
        throw new Error("Canceled inspection must not bind the Gateway port");
      });
      const fixture = (executable: string) =>
        commandResult(
          executable === "lsof"
            ? "p8000\ncnode\nn127.0.0.1:18789\n"
            : executable === "netstat.exe"
              ? "TCP 127.0.0.1:18789 0.0.0.0:0 LISTENING 8000\n"
              : "",
        );
      runCommand.mockImplementation(async (argv) => {
        const executable = path.win32.basename(argv[0] ?? "");
        if (executable === command) {
          entered.resolve();
          return release.promise;
        }
        return fixture(executable);
      });
      const result = inspectPortUsage(18789, {
        probeHosts: ["127.0.0.1"],
        signal: controller.signal,
      }).catch((error: unknown) => error);
      await entered.promise;
      const commandsAtCancellation = runCommand.mock.calls.length;
      const reason = new Error("settle deadline expired");
      controller.abort(reason);
      release.resolve(failure ? commandResult("", 2) : fixture(command));
      await Promise.all(runCommand.mock.results.map((invocation) => invocation.value));
      expect(await result).toBe(reason);
      expect(runCommand).toHaveBeenCalledTimes(commandsAtCancellation);
      expect(bind).not.toHaveBeenCalled();
      for (const call of runCommand.mock.calls) {
        expect(call[1]).toEqual(expect.objectContaining({ signal: controller.signal }));
      }
    },
  );
});

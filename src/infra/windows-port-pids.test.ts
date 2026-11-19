import { afterEach, expect, it, vi } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { readWindowsListeningPidsResultSync } from "./windows-port-pids.js";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawn,
}));
vi.mock("./windows-appcontainer-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-appcontainer-spawn.js")>()),
  assertAppContainerSpawnSupported: () => {},
}));
vi.mock("./windows-install-roots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-install-roots.js")>()),
  getWindowsPowerShellExePath: () => "powershell.exe",
  getWindowsSystem32ExePath: (name: string) => name,
  getWindowsWmicExePath: () => "wmic.exe",
}));
vi.mock("./process-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process-env.js")>()),
  resolveDiagnosticProcessEnv: () => ({}),
}));

const ok = (stdout: string) => ({ status: 0, stdout, stderr: "", error: undefined });

afterEach(() => vi.clearAllMocks());

it("reports a listener that netstat sees after an empty PowerShell census", () => {
  spawn
    .mockReturnValueOnce(ok(""))
    .mockReturnValueOnce(ok("TCP 127.0.0.1:18789 0.0.0.0:0 LISTENING 4242\n"));

  const result = withMockedWindowsPlatform(() => readWindowsListeningPidsResultSync(18789));

  expect(result).toEqual({ ok: true, pids: [4242] });
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("keeps a non-empty PowerShell census without a second query", () => {
  spawn.mockReturnValueOnce(ok("4242\n"));

  const result = withMockedWindowsPlatform(() => readWindowsListeningPidsResultSync(18789));

  expect(result).toEqual({ ok: true, pids: [4242] });
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("reports empty only when both native collectors see no listener", () => {
  spawn.mockReturnValueOnce(ok("")).mockReturnValueOnce(ok(""));

  const result = withMockedWindowsPlatform(() => readWindowsListeningPidsResultSync(18789));

  expect(result).toEqual({ ok: true, pids: [] });
});

import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readWindowsListeningPidsResultSync } from "./windows-port-pids.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawn,
}));
// mock-isolation: Native utility locations must not depend on the host registry.
vi.mock("./windows-install-roots.js", () => ({
  getWindowsPowerShellExePath: () => "C:\\Windows\\System32\\powershell.exe",
  getWindowsSystem32ExePath: (name: string) => `C:\\Windows\\System32\\${name}`,
  getWindowsWmicExePath: () => "C:\\Windows\\System32\\wmic.exe",
}));
// mock-isolation: Synthetic subprocess results do not inspect the host access token.
vi.mock("./windows-appcontainer-spawn.js", () => ({
  assertAppContainerSpawnSupported: () => {},
}));

afterEach(() => vi.resetAllMocks());

it.each([
  {
    name: "finds a listener omitted by a successful PowerShell query",
    powershell: "",
    netstat: "TCP 127.0.0.1:43123 0.0.0.0:0 LISTENING 424242\r\n",
    expected: { ok: true, pids: [424242] },
  },
  {
    name: "confirms an empty port with both collectors",
    powershell: "",
    netstat: "",
    expected: { ok: true, pids: [] },
  },
  {
    name: "keeps an empty query indeterminate when netstat fails",
    powershell: "",
    netstat: undefined,
    expected: { ok: false, permanent: false },
  },
  {
    name: "retains a populated PowerShell result without another collector",
    powershell: "424242\r\n",
    netstat: undefined,
    expected: { ok: true, pids: [424242] },
  },
])("$name", ({ powershell, netstat, expected }) => {
  spawn.mockImplementation((file: string) => {
    if (path.win32.basename(file) === "powershell.exe") {
      return { status: 0, stdout: powershell, stderr: "" };
    }
    return { status: netstat === undefined ? 1 : 0, stdout: netstat ?? "", stderr: "" };
  });

  expect(readWindowsListeningPidsResultSync(43123)).toEqual(expected);
  if (powershell) {
    expect(spawn).toHaveBeenCalledOnce();
  }
});

import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { readRelatedProcessDiagnostics } from "./schtasks.integration-observation.test-support.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

it("does not require diagnostic context parents to exit with owned descendants", () => {
  const entries = [
    { ProcessId: 10, ParentProcessId: 1, CommandLine: "svchost.exe -k netsvcs" },
    { ProcessId: 24, ParentProcessId: 23, CommandLine: "idle-child.exe" },
    { ProcessId: 23, ParentProcessId: 22, CommandLine: "conhost.exe" },
    { ProcessId: 22, ParentProcessId: 21, CommandLine: "node C:/fixture/probe.mts" },
    { ProcessId: 21, ParentProcessId: 20, CommandLine: "node C:/fixture/probe.mts supervisor" },
    { ProcessId: 20, ParentProcessId: 10, CommandLine: "cmd /c C:/fixture/gateway.cmd" },
    { ProcessId: 90, ParentProcessId: 10, CommandLine: "unrelated-task.exe" },
    { ProcessId: 91, ParentProcessId: 90, CommandLine: "unrelated-child.exe" },
    { ProcessId: 100, ParentProcessId: 1, CommandLine: "other.exe" },
  ];
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    signal: null,
    pid: 999,
    output: [],
    stderr: "",
    stdout: JSON.stringify(entries),
  });
  const processCapture = readRelatedProcessDiagnostics([
    "C:\\fixture\\probe.mts",
    "C:\\fixture\\gateway.cmd",
  ]);
  expect(processCapture.ok).toBe(true);
  expect(processCapture.truncated).toBe(false);
  expect(processCapture.processes.map((entry) => entry.ProcessId)).toEqual([
    10, 24, 23, 22, 21, 20,
  ]);
  expect(processCapture.ownedPids.toSorted((a, b) => a - b)).toEqual([20, 21, 22, 23, 24]);
  const context = readRelatedProcessDiagnostics([], [24, 90]);
  expect(context.ownedPids).toEqual([]);
  expect(context.processes.map((entry) => entry.ProcessId)).toEqual([24, 90]);
});

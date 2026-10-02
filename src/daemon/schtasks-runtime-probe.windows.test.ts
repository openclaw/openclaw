import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { readScheduledTaskRuntime } from "./schtasks-runtime.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => ""),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.mocked(spawn).mockReset();
  vi.mocked(spawnSync)
    .mockReset()
    .mockReturnValue({
      pid: 0,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
    });
});

afterEach(() => vi.restoreAllMocks());

it.each([
  { budget: undefined, expected: 60_000 },
  { budget: 5_000, expected: 5_000 },
  { budget: 60_000, expected: 60_000 },
  { budget: 750, expected: 750 },
])("preserves the caller's native inspection budget $budget", async ({ budget, expected }) => {
  await expect(readScheduledTaskRuntime({}, { timeoutMs: budget })).resolves.toEqual({
    status: "unknown",
    detail: "service runtime inspection failed",
    inspectionFailure: {
      code: "service-runtime-inspection-failed",
      detail: `Scheduled Task probe timed out after ${expected} ms (ETIMEDOUT).`,
      timeoutMs: expected,
    },
    missingUnit: false,
  });
  expect(spawnSync).toHaveBeenCalledOnce();
  expect(vi.mocked(spawnSync).mock.calls[0]?.[0]).toBe(getWindowsPowerShellExePath());
  expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.timeout).toBe(expected);
  expect(spawn).not.toHaveBeenCalled();
});

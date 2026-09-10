import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeScheduledTaskState } from "./schtasks-state-probe.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => vi.mocked(spawnSync).mockReset());

describe("Scheduled Task probe timeout", () => {
  it.each([
    { budget: undefined, expected: 5_000 },
    { budget: 0, expected: 5_000 },
    { budget: -1, expected: 5_000 },
    { budget: Number.POSITIVE_INFINITY, expected: 5_000 },
    { budget: 200, expected: 200 },
    { budget: 30_000, expected: 30_000 },
  ])("uses a bounded caller budget: $budget -> $expected ms", ({ budget, expected }) => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }),
    });

    const result = probeScheduledTaskState("OpenClaw Gateway", budget);

    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.timeout).toBe(expected);
    expect(result).toEqual({
      status: "unknown",
      detail: `Scheduled Task probe timed out after ${expected} ms (ETIMEDOUT).`,
      timeoutMs: expected,
    });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});

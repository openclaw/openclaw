import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSelfAndAncestorPidsSync } from "./restart-stale-pids.js";
import { inspectUpdateRepairDriverAdmission } from "./update-run-activity.js";
import type { UpdateRunRecord } from "./update-run-record.js";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));

const repairPid = process.pid + 7001;
const updaterPid = process.pid + 7002;
const runId = "8e926353-5041-468b-b0af-de4174620349";
const originalStart = Date.parse("2026-09-03T00:00:00Z");
const repairStart = originalStart + 1000;
const doctorStart = repairStart + 1000;
const ticks = (milliseconds: number) =>
  String(BigInt(milliseconds) * 10_000n + 621355968000000000n);

function updateRun(updaterStart = originalStart): UpdateRunRecord {
  return {
    runId,
    createdAtMs: originalStart,
    updatedAtMs: repairStart,
    trigger: "cli",
    phase: "validating",
    status: "running",
    reason: null,
    origin: {
      driver: { host: hostname(), pid: repairPid, startIdentity: String(repairStart) },
      previousDrivers: [{ host: hostname(), pid: updaterPid, startIdentity: String(updaterStart) }],
    },
    target: {},
    before: {},
    after: {},
    steps: [],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: null,
    downtimeMs: null,
  };
}

describe("Windows update repair continuation", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "ppid", "get").mockReturnValue(repairPid);
    vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "original updater", updaterStart: originalStart, expected: true },
    { name: "reused updater PID", updaterStart: repairStart + 1, expected: false },
  ])("admits Doctor only beneath the live $name", ({ updaterStart, expected }) => {
    spawnSync.mockImplementation((_command: string, args: string[]) => {
      const script = args.at(-1) ?? "";
      if (script.includes("Get-CimInstance")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { pid: process.pid, parentPid: repairPid, startedAt: ticks(doctorStart) },
            { pid: repairPid, parentPid: updaterPid, startedAt: ticks(repairStart) },
            { pid: updaterPid, parentPid: 0, startedAt: ticks(updaterStart) },
          ]),
        };
      }
      const pid = Number(/GetProcessById\((\d+)\)/.exec(script)?.[1]);
      return {
        status: 0,
        stdout: new Date(pid === repairPid ? repairStart : updaterStart).toISOString(),
      };
    });

    expect(inspectUpdateRepairDriverAdmission([updateRun(updaterStart)], runId).kind).toBe(
      expected ? "continuation" : "conflict",
    );
  });

  it("keeps self and direct parent when transitive ancestry cannot be inspected", () => {
    spawnSync.mockReturnValue({ status: 1, stdout: "" });
    expect(getSelfAndAncestorPidsSync()).toEqual(new Set([process.pid, repairPid]));
  });

  it("does not authorize a reused direct parent protected by cleanup", () => {
    const replacementStart = doctorStart + 1000;
    spawnSync.mockImplementation((_command: string, args: string[]) => ({
      status: 0,
      stdout: (args.at(-1) ?? "").includes("Get-CimInstance")
        ? JSON.stringify([
            { pid: process.pid, parentPid: repairPid, startedAt: ticks(doctorStart) },
            { pid: repairPid, parentPid: 0, startedAt: ticks(replacementStart) },
          ])
        : new Date(replacementStart).toISOString(),
    }));
    const run = updateRun();
    run.origin = {
      driver: { host: hostname(), pid: repairPid, startIdentity: String(replacementStart) },
    };

    expect(getSelfAndAncestorPidsSync().has(repairPid)).toBe(true);
    expect(inspectUpdateRepairDriverAdmission([run], runId).kind).toBe("conflict");
  });
});

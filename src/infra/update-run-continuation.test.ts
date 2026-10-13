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

// Verified ancestry is retained for the process, so tests of an unverified
// driver use an identity no earlier test has verified.
const unverifiedPid = repairPid + 100;
function unverifiedDriverRun(): UpdateRunRecord {
  const run = updateRun();
  run.origin = {
    driver: { host: hostname(), pid: unverifiedPid, startIdentity: String(repairStart) },
  };
  return run;
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
  function mockWindowsProcesses(
    ancestry: () => { status: number; stdout: string },
    driverStart: () => number,
  ) {
    spawnSync.mockImplementation((_command: string, args: string[]) =>
      (args.at(-1) ?? "").includes("Get-CimInstance")
        ? ancestry()
        : { status: 0, stdout: new Date(driverStart()).toISOString() },
    );
  }

  it("grants continuation when an incomplete chain contains the verified live driver", () => {
    // Windows chains usually end at an exited parent; every collected PID is still a
    // creation-ordered ancestor, so finding the driver proves the continuation.
    const chainPid = repairPid + 300;
    const run = updateRun();
    run.origin = {
      driver: { host: hostname(), pid: chainPid, startIdentity: String(repairStart) },
    };
    mockWindowsProcesses(
      () => ({
        status: 0,
        stdout: JSON.stringify([
          { pid: process.pid, parentPid: chainPid, startedAt: ticks(doctorStart) },
          { pid: chainPid, parentPid: updaterPid, startedAt: ticks(repairStart) },
        ]),
      }),
      () => repairStart,
    );
    expect(getSelfAndAncestorPidsSync().has(chainPid)).toBe(true);
    expect(inspectUpdateRepairDriverAdmission([run], runId).kind).toBe("continuation");
  });

  it("keeps a verified continuation when a later ancestry read fails", () => {
    const retainedPid = repairPid + 200;
    const run = (startIdentity: number): UpdateRunRecord => ({
      ...updateRun(),
      origin: {
        driver: { host: hostname(), pid: retainedPid, startIdentity: String(startIdentity) },
      },
    });
    let ancestryReads = 0;
    let driverStart = repairStart;
    mockWindowsProcesses(
      () =>
        ++ancestryReads === 1
          ? {
              status: 0,
              stdout: JSON.stringify([
                { pid: process.pid, parentPid: retainedPid, startedAt: ticks(doctorStart) },
                { pid: retainedPid, parentPid: 0, startedAt: ticks(repairStart) },
              ]),
            }
          : { status: 1, stdout: "" },
      () => driverStart,
    );

    expect(inspectUpdateRepairDriverAdmission([run(repairStart)], runId).kind).toBe("continuation");
    expect(ancestryReads).toBe(1);
    expect(inspectUpdateRepairDriverAdmission([run(repairStart)], runId).kind).toBe("continuation");

    // Retained proof is bound to the verified identity, never to a reused PID.
    const reusedStart = doctorStart + 1000;
    driverStart = reusedStart;
    expect(inspectUpdateRepairDriverAdmission([run(reusedStart)], runId)).toMatchObject({
      kind: "conflict",
      message: expect.stringContaining("could not read this process's ancestry"),
    });
  });

  it("reports unreadable ancestry instead of a conflicting live update", () => {
    mockWindowsProcesses(
      () => ({ status: 1, stdout: "" }),
      () => repairStart,
    );

    const admission = inspectUpdateRepairDriverAdmission([unverifiedDriverRun()], runId);
    expect(admission).toMatchObject({
      kind: "conflict",
      message: expect.stringContaining("not evidence of another update"),
    });
    expect(admission).not.toMatchObject({ message: expect.stringContaining("liveness: alive") });
  });
});

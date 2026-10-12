import { hostname } from "node:os";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSelfAndAncestorPidsSync } from "./restart-stale-pids.js";
import { inspectUpdateRepairDriverAdmission } from "./update-run-activity.js";
import type { UpdateRunRecord } from "./update-run-record.js";

const readProcessAncestry = vi.hoisted(() =>
  vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessAncestry>(),
);
// Without a native identity addon, liveness and start times come from the mocked
// Windows process queries instead of the test host's own native process table.
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessAncestry,
  readProcessIdentity: () => {
    throw new ProcSafeError("helper-unavailable", "native process identity is unavailable");
  },
}));

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
const identity = (pid: number, parentPid: number, startedAt: number) => ({
  pid,
  parentPid,
  startTimeMicros: startedAt * 1000,
  startTimeResolutionMicros: 1,
  exited: false,
});

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
    readProcessAncestry.mockReset().mockReturnValue(null);
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
    readProcessAncestry.mockReturnValue({
      chain: [
        identity(process.pid, repairPid, doctorStart),
        identity(repairPid, updaterPid, repairStart),
        ...(updaterStart > repairStart ? [] : [identity(updaterPid, 0, updaterStart)]),
      ],
      complete: true,
      stoppedBy: updaterStart > repairStart ? "recycled-parent" : "root",
    });
    spawnSync.mockImplementation((_command: string, args: string[]) => {
      const pid = Number(/GetProcessById\((\d+)\)/.exec(args.at(-1) ?? "")?.[1]);
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
    readProcessAncestry.mockReturnValue({
      chain: [identity(process.pid, repairPid, doctorStart)],
      complete: true,
      stoppedBy: "recycled-parent",
    });
    spawnSync.mockReturnValue({ status: 0, stdout: new Date(replacementStart).toISOString() });
    const run = updateRun();
    run.origin = {
      driver: { host: hostname(), pid: repairPid, startIdentity: String(replacementStart) },
    };

    expect(getSelfAndAncestorPidsSync().has(repairPid)).toBe(true);
    expect(inspectUpdateRepairDriverAdmission([run], runId).kind).toBe("conflict");
  });
  it("does not grant continuation from an incomplete chain containing the live driver", () => {
    readProcessAncestry.mockReturnValue({
      chain: [
        identity(process.pid, unverifiedPid, doctorStart),
        identity(unverifiedPid, updaterPid, repairStart),
      ],
      complete: false,
      stoppedBy: "unreadable-parent",
    });
    spawnSync.mockReturnValue({ status: 0, stdout: new Date(repairStart).toISOString() });
    expect(getSelfAndAncestorPidsSync().has(unverifiedPid)).toBe(true);
    expect(inspectUpdateRepairDriverAdmission([unverifiedDriverRun()], runId).kind).toBe(
      "conflict",
    );
  });

  it("keeps a verified continuation when a later ancestry read fails", () => {
    const retainedPid = repairPid + 200;
    const run = (startIdentity: number): UpdateRunRecord => ({
      ...updateRun(),
      origin: {
        driver: { host: hostname(), pid: retainedPid, startIdentity: String(startIdentity) },
      },
    });
    readProcessAncestry
      .mockReturnValueOnce({
        chain: [
          identity(process.pid, retainedPid, doctorStart),
          identity(retainedPid, 0, repairStart),
        ],
        complete: true,
        stoppedBy: "root",
      })
      .mockImplementation(() => {
        throw new Error("process snapshot timed out");
      });
    spawnSync.mockReturnValue({ status: 0, stdout: new Date(repairStart).toISOString() });

    expect(inspectUpdateRepairDriverAdmission([run(repairStart)], runId).kind).toBe("continuation");
    expect(readProcessAncestry).toHaveBeenCalledTimes(1);
    expect(inspectUpdateRepairDriverAdmission([run(repairStart)], runId).kind).toBe("continuation");

    // Retained proof is bound to the verified identity, never to a reused PID.
    const reusedStart = doctorStart + 1000;
    spawnSync.mockReturnValue({ status: 0, stdout: new Date(reusedStart).toISOString() });
    expect(inspectUpdateRepairDriverAdmission([run(reusedStart)], runId)).toMatchObject({
      kind: "conflict",
      message: expect.stringContaining("could not read this process's ancestry"),
    });
  });

  it("reports unreadable ancestry instead of a conflicting live update", () => {
    readProcessAncestry.mockImplementation(() => {
      throw new Error("process snapshot timed out");
    });
    spawnSync.mockReturnValue({ status: 0, stdout: new Date(repairStart).toISOString() });

    const admission = inspectUpdateRepairDriverAdmission([unverifiedDriverRun()], runId);
    expect(admission).toMatchObject({
      kind: "conflict",
      message: expect.stringContaining("not evidence of another update"),
    });
    expect(admission).not.toMatchObject({ message: expect.stringContaining("liveness: alive") });
  });
});

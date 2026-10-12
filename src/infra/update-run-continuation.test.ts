import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSelfAndAncestorPidsSync } from "./restart-stale-pids.js";
import { inspectUpdateRepairDriverAdmission } from "./update-run-activity.js";
import type { UpdateRunRecord } from "./update-run-record.js";

const { readProcessAncestry, readProcessIdentity } = vi.hoisted(() => ({
  readProcessAncestry: vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessAncestry>(),
  readProcessIdentity: vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessIdentity>(),
}));
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessAncestry,
  readProcessIdentity,
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

describe("Windows update repair continuation", () => {
  beforeEach(() => {
    readProcessAncestry.mockReset().mockReturnValue(null);
    readProcessIdentity.mockReset().mockReturnValue(null);
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
    readProcessIdentity.mockImplementation((pid) =>
      identity(pid, 0, pid === repairPid ? repairStart : updaterStart),
    );

    expect(inspectUpdateRepairDriverAdmission([updateRun(updaterStart)], runId).kind).toBe(
      expected ? "continuation" : "conflict",
    );
  });

  it("keeps self and direct parent when transitive ancestry cannot be inspected", () => {
    expect(getSelfAndAncestorPidsSync()).toEqual(new Set([process.pid, repairPid]));
  });

  it("does not authorize a reused direct parent protected by cleanup", () => {
    const replacementStart = doctorStart + 1000;
    readProcessAncestry.mockReturnValue({
      chain: [identity(process.pid, repairPid, doctorStart)],
      complete: true,
      stoppedBy: "recycled-parent",
    });
    readProcessIdentity.mockImplementation((pid) => identity(pid, 0, replacementStart));
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
        identity(process.pid, repairPid, doctorStart),
        identity(repairPid, updaterPid, repairStart),
      ],
      complete: false,
      stoppedBy: "unreadable-parent",
    });
    readProcessIdentity.mockImplementation((pid) => identity(pid, 0, repairStart));
    const run = updateRun();
    run.origin.previousDrivers = [];
    expect(getSelfAndAncestorPidsSync().has(repairPid)).toBe(true);
    expect(inspectUpdateRepairDriverAdmission([run], runId).kind).toBe("conflict");
  });
});

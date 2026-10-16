import { hostname } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSelfAndAncestorPidsSync as ancestorPids } from "./restart-stale-pids.js";
import {
  isBorrowedLegacyHandoffParentCurrent as isParentCurrent,
  readBorrowedLegacyHandoffParent as readParent,
} from "./update-managed-service-handoff-legacy-parent.js";
import { createManagedHandoffProcessIdentityReader as processReader } from "./update-managed-service-handoff-process.js";
import { inspectUpdateRepairDriverAdmission } from "./update-run-activity.js";
import type { UpdateRunRecord } from "./update-run-record.js";

const readProcessAncestry = vi.hoisted(() =>
  vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessAncestry>(),
);
const readProcessIdentity = vi.hoisted(() =>
  vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessIdentity>(),
);
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
const driver = (pid: number, startedAt = repairStart) => ({
  host: hostname(),
  pid,
  startIdentity: String(startedAt),
});
type ProcessRef = Parameters<typeof identity>;
const doctor: ProcessRef = [process.pid, repairPid, doctorStart];
const repair: ProcessRef = [repairPid, updaterPid, repairStart];
const lineage = (pid: number, parent = 0): ProcessRef[] => [
  [process.pid, pid, doctorStart],
  [pid, parent, repairStart],
];
function ancestry(
  refs: ProcessRef[],
  stoppedBy: NonNullable<ReturnType<typeof readProcessAncestry>>["stoppedBy"] = "root",
  complete = true,
) {
  return { chain: refs.map((ref) => identity(...ref)), complete, stoppedBy };
}
function admit(run: UpdateRunRecord) {
  return inspectUpdateRepairDriverAdmission([run], runId);
}
function mockIdentities(updaterStart = originalStart) {
  readProcessIdentity.mockImplementation((pid) =>
    pid === repairPid
      ? identity(repairPid, updaterPid, repairStart)
      : pid === updaterPid
        ? identity(updaterPid, 0, updaterStart)
        : null,
  );
}
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
      driver: driver(repairPid),
      previousDrivers: [driver(updaterPid, updaterStart)],
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
function singleDriverRun(pid: number, start = repairStart): UpdateRunRecord {
  const run = updateRun();
  run.origin = { driver: driver(pid, start) };
  return run;
}

beforeEach(() => {
  readProcessAncestry.mockReset().mockReturnValue(null);
  readProcessIdentity.mockReset();
  mockIdentities();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(process, "ppid", "get").mockReturnValue(repairPid);
  vi.spyOn(process, "kill").mockReturnValue(true);
});

afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "original updater", updaterStart: originalStart, expected: true },
  { name: "reused updater PID", updaterStart: repairStart + 1, expected: false },
])("admits Doctor only beneath the live $name", ({ updaterStart, expected }) => {
  mockIdentities(updaterStart);
  readProcessAncestry.mockReturnValue(
    ancestry(
      updaterStart > repairStart
        ? [doctor, repair]
        : [doctor, repair, [updaterPid, 0, updaterStart]],
      updaterStart > repairStart ? "recycled-parent" : "root",
    ),
  );
  expect(admit(updateRun(updaterStart)).kind).toBe(expected ? "continuation" : "conflict");
});

it("keeps self and direct parent when transitive ancestry cannot be inspected", () => {
  expect(ancestorPids()).toEqual(new Set([process.pid, repairPid]));
});

it.each([true, false])("rejects unverified driver ancestry (reused direct parent=%s)", (reused) => {
  const pid = reused ? repairPid : unverifiedPid;
  const start = reused ? doctorStart + 1000 : repairStart;
  readProcessAncestry.mockReturnValue(
    reused
      ? ancestry([doctor], "recycled-parent")
      : ancestry(lineage(pid, updaterPid), "unreadable-parent", false),
  );
  readProcessIdentity.mockImplementation((current) => identity(reused ? pid : current, 0, start));
  expect(ancestorPids().has(pid)).toBe(true);
  expect(admit(singleDriverRun(pid, start)).kind).toBe("conflict");
});

it("keeps a verified continuation when a later ancestry read fails", () => {
  const retainedPid = repairPid + 200;
  readProcessAncestry.mockReturnValueOnce(ancestry(lineage(retainedPid))).mockImplementation(() => {
    throw new Error("process snapshot timed out");
  });
  readProcessIdentity.mockImplementation((pid) => identity(pid, 0, repairStart));

  expect(admit(singleDriverRun(retainedPid)).kind).toBe("continuation");
  expect(readProcessAncestry).toHaveBeenCalledTimes(1);
  expect(admit(singleDriverRun(retainedPid)).kind).toBe("continuation");

  // Retained proof is bound to the verified identity, never to a reused PID.
  const reusedStart = doctorStart + 1000;
  readProcessIdentity.mockImplementation((pid) => identity(pid, 0, reusedStart));
  expect(admit(singleDriverRun(retainedPid, reusedStart))).toMatchObject({
    kind: "conflict",
    message: expect.stringContaining("could not read this process's ancestry"),
  });
});

it("requires readable ancestry through every live driver", () => {
  const currentPid = repairPid + 301;
  const previousPid = updaterPid + 500;
  readProcessAncestry.mockImplementation((_pid, options) =>
    ancestry(
      lineage(currentPid, previousPid),
      options?.throughPid === currentPid ? "through-pid" : "unreadable-parent",
      options?.throughPid === currentPid,
    ),
  );
  const run = updateRun();
  run.origin.driver = driver(currentPid);
  run.origin.previousDrivers = [driver(previousPid, originalStart)];
  readProcessIdentity.mockImplementation((pid) =>
    identity(pid, 0, pid === currentPid ? repairStart : originalStart),
  );
  expect(ancestorPids().has(currentPid)).toBe(true);
  expect(admit(run).kind).toBe("conflict");
});

it.each(["current", "unreadable-helper", "reused-helper", "replaced-row"] as const)(
  "validates borrowed helper custody through its recorded ancestor: %s",
  (fault) => {
    const row = {
      owner: "original-helper",
      payload_json: JSON.stringify({
        version: 1,
        pid: updaterPid,
        startIdentity: String(originalStart),
      }),
      updated_at: originalStart,
    };
    const parent = readParent("/synthetic-install", row, {
      pid: repairPid,
      startIdentity: String(repairStart),
    });
    if (!parent) {
      throw new Error("The fixture requires its recorded helper custody");
    }
    const readable = (pid?: number) => fault !== "unreadable-helper" && pid === updaterPid;
    readProcessAncestry.mockImplementation((_pid, options) =>
      ancestry(
        fault === "unreadable-helper"
          ? [doctor, repair]
          : [doctor, repair, [updaterPid, updaterPid + 1, originalStart]],
        readable(options?.throughPid) ? "through-pid" : "unreadable-parent",
        readable(options?.throughPid),
      ),
    );
    if (fault === "reused-helper") {
      readProcessIdentity.mockImplementation((pid) =>
        pid === repairPid
          ? identity(repairPid, updaterPid, repairStart)
          : identity(updaterPid, 0, originalStart + 1),
      );
    }
    const current = fault === "replaced-row" ? { ...row, owner: "replacement" } : row;
    expect(isParentCurrent(parent, () => current, processReader({ env: {} }))).toBe(
      fault === "current",
    );
  },
);

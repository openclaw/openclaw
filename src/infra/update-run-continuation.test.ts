import fs from "node:fs";
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
import { createUpdateRunRecordFixture } from "./update-run-record.test-support.js";

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
function ancestry(
  pids: number[],
  stoppedBy: NonNullable<ReturnType<typeof readProcessAncestry>>["stoppedBy"] = "root",
  finalParent = 0,
) {
  const starts = [doctorStart, repairStart, originalStart];
  return {
    chain: pids.map((pid, index) => identity(pid, pids[index + 1] ?? finalParent, starts[index]!)),
    complete: stoppedBy !== "unreadable-parent",
    stoppedBy,
  };
}
const admit = (run: UpdateRunRecord) => inspectUpdateRepairDriverAdmission([run], runId);
function mockIdentities(updaterStart = originalStart) {
  const identities = new Map([
    [repairPid, identity(repairPid, updaterPid, repairStart)],
    [updaterPid, identity(updaterPid, 0, updaterStart)],
  ]);
  readProcessIdentity.mockImplementation((pid) => identities.get(pid) ?? null);
}
function updateRun(pid: number, start = repairStart, previous?: [number, number]): UpdateRunRecord {
  return createUpdateRunRecordFixture(runId, {
    createdAtMs: originalStart,
    updatedAtMs: repairStart,
    phase: "validating",
    status: "running",
    origin: {
      driver: driver(pid, start),
      ...(previous ? { previousDrivers: [driver(...previous)] } : {}),
    },
    finishedAtMs: null,
  });
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

it.each(["root", "recycled-parent", "unreadable-parent"] as const)(
  "verifies every recorded native ancestor's birth and visibility: %s",
  (fault) => {
    const current = repairPid + 300 + fault.length;
    const previous = updaterPid + 500 + fault.length;
    const start = fault === "recycled-parent" ? repairStart + 1 : originalStart;
    readProcessIdentity.mockImplementation((pid) =>
      identity(pid, 0, pid === current ? repairStart : start),
    );
    readProcessAncestry.mockImplementation((_pid, options) =>
      ancestry(
        [process.pid, current, ...(fault === "root" ? [previous] : [])],
        options?.throughPid === current ? "through-pid" : fault,
        previous,
      ),
    );
    expect(ancestorPids().has(current)).toBe(true);
    expect(admit(updateRun(current, repairStart, [previous, start])).kind).toBe(
      fault === "root" ? "continuation" : "conflict",
    );
  },
);

it.each(["current", "reused", "unreadable", "cycle", "stray"])(
  "verifies Linux continuation with unavailable native ancestry: %s",
  (fault) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    readProcessAncestry.mockImplementation(() => {
      throw new Error("GLIBC_2.33 not found");
    });
    const pid = repairPid + 400 + fault.length;
    const start = fault === "reused" ? doctorStart + 1 : repairStart;
    const parents = new Map([
      [process.pid, pid],
      [pid, 1],
    ]);
    if (fault === "stray") {
      parents.set(process.pid, 1);
    }
    if (fault === "cycle") {
      parents.set(process.pid, process.pid);
    }
    vi.spyOn(fs, "readFileSync").mockImplementation((file) => {
      const current = Number(/^\/proc\/(\d+)\/stat$/.exec(String(file))?.[1]);
      if (!parents.has(current) || (fault === "unreadable" && current === pid)) {
        throw new Error("procfs unavailable");
      }
      return `${current} (node (update)) S ${parents.get(current)} ${"0 ".repeat(17)}${current === process.pid ? doctorStart : start}`;
    });
    expect(admit(updateRun(pid, start)).kind).toBe(
      fault === "current" ? "continuation" : "conflict",
    );
  },
);

it("keeps a verified continuation when a later ancestry read fails", () => {
  const retainedPid = repairPid + 200;
  readProcessAncestry
    .mockReturnValueOnce(ancestry([process.pid, retainedPid]))
    .mockImplementation(() => {
      throw new Error("process snapshot timed out");
    });
  readProcessIdentity.mockImplementation((pid) => identity(pid, 0, repairStart));

  expect(admit(updateRun(retainedPid)).kind).toBe("continuation");
  expect(admit(updateRun(retainedPid)).kind).toBe("continuation");

  // Retained proof is bound to the verified identity, never to a reused PID.
  const reusedStart = doctorStart + 1000;
  readProcessIdentity.mockImplementation((pid) => identity(pid, 0, reusedStart));
  expect(admit(updateRun(retainedPid, reusedStart))).toMatchObject({
    kind: "conflict",
    message: expect.stringContaining("could not read this process's ancestry"),
  });
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
          ? [process.pid, repairPid]
          : [process.pid, repairPid, updaterPid],
        readable(options?.throughPid) ? "through-pid" : "unreadable-parent",
        fault === "unreadable-helper" ? updaterPid : updaterPid + 1,
      ),
    );
    if (fault === "reused-helper") {
      mockIdentities(originalStart + 1);
    }
    const current = fault === "replaced-row" ? { ...row, owner: "replacement" } : row;
    expect(isParentCurrent(parent, () => current, processReader({ env: {} }))).toBe(
      fault === "current",
    );
  },
);

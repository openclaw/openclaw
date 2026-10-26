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
function admit(run: UpdateRunRecord) {
  return inspectUpdateRepairDriverAdmission([run], runId);
}
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

// Keep unverified fixtures outside identities cached by earlier cases.
const unverifiedPid = repairPid + 100;

beforeEach(() => {
  readProcessAncestry.mockReset().mockReturnValue(null);
  readProcessIdentity.mockReset();
  mockIdentities();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(process, "ppid", "get").mockReturnValue(repairPid);
  vi.spyOn(process, "kill").mockReturnValue(true);
});

afterEach(() => vi.restoreAllMocks());

it.each([originalStart, repairStart + 1])(
  "checks original updater birth time %s",
  (updaterStart) => {
    const reused = updaterStart > repairStart;
    mockIdentities(updaterStart);
    readProcessAncestry.mockReturnValue(
      ancestry(
        reused ? [process.pid, repairPid] : [process.pid, repairPid, updaterPid],
        reused ? "recycled-parent" : "root",
        reused ? updaterPid : 0,
      ),
    );
    expect(admit(updateRun(repairPid, repairStart, [updaterPid, updaterStart])).kind).toBe(
      reused ? "conflict" : "continuation",
    );
  },
);

it("keeps self and direct parent when transitive ancestry cannot be inspected", () => {
  expect(ancestorPids()).toEqual(new Set([process.pid, repairPid]));
});

it.each([true, false])("rejects unverified driver ancestry (reused direct parent=%s)", (reused) => {
  const pid = reused ? repairPid : unverifiedPid;
  const start = reused ? doctorStart + 1000 : repairStart;
  readProcessAncestry.mockReturnValue(
    reused
      ? ancestry([process.pid], "recycled-parent", repairPid)
      : ancestry([process.pid, pid], "unreadable-parent", updaterPid),
  );
  readProcessIdentity.mockImplementation((current) => identity(reused ? pid : current, 0, start));
  expect(ancestorPids().has(pid)).toBe(true);
  expect(admit(updateRun(pid, start)).kind).toBe("conflict");
});

it("keeps a verified continuation when a later ancestry read fails", () => {
  const retainedPid = repairPid + 200;
  readProcessAncestry
    .mockReturnValueOnce(ancestry([process.pid, retainedPid]))
    .mockImplementation(() => {
      throw new Error("process snapshot timed out");
    });
  readProcessIdentity.mockImplementation((pid) => identity(pid, 0, repairStart));

  expect(admit(updateRun(retainedPid)).kind).toBe("continuation");
  expect(readProcessAncestry).toHaveBeenCalledTimes(1);
  expect(admit(updateRun(retainedPid)).kind).toBe("continuation");

  // Retained proof is bound to the verified identity, never to a reused PID.
  const reusedStart = doctorStart + 1000;
  readProcessIdentity.mockImplementation((pid) => identity(pid, 0, reusedStart));
  expect(admit(updateRun(retainedPid, reusedStart))).toMatchObject({
    kind: "conflict",
    message: expect.stringContaining("could not read this process's ancestry"),
  });
});

it("requires readable ancestry through every live driver", () => {
  const currentPid = repairPid + 301;
  const previousPid = updaterPid + 500;
  readProcessAncestry.mockImplementation((_pid, options) =>
    ancestry(
      [process.pid, currentPid],
      options?.throughPid === currentPid ? "through-pid" : "unreadable-parent",
      previousPid,
    ),
  );
  const run = updateRun(currentPid, repairStart, [previousPid, originalStart]);
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

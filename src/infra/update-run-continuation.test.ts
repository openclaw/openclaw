import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSelfAndAncestorPidsSync } from "./restart-stale-pids.js";
import {
  isBorrowedLegacyHandoffParentCurrent,
  readBorrowedLegacyHandoffParent,
} from "./update-managed-service-handoff-legacy-parent.js";
import { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
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
    readProcessIdentity
      .mockReset()
      .mockImplementation((pid) =>
        pid === repairPid
          ? identity(repairPid, updaterPid, repairStart)
          : pid === updaterPid
            ? identity(updaterPid, 0, originalStart)
            : null,
      );
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "ppid", "get").mockReturnValue(repairPid);
    vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "original updater", updaterStart: originalStart, expected: true },
    { name: "reused updater PID", updaterStart: repairStart + 1, expected: false },
  ])("admits Doctor only beneath the live $name", ({ updaterStart, expected }) => {
    readProcessIdentity.mockImplementation((pid) =>
      pid === repairPid
        ? identity(repairPid, updaterPid, repairStart)
        : pid === updaterPid
          ? identity(updaterPid, 0, updaterStart)
          : null,
    );
    readProcessAncestry.mockReturnValue({
      chain: [
        identity(process.pid, repairPid, doctorStart),
        identity(repairPid, updaterPid, repairStart),
        ...(updaterStart > repairStart ? [] : [identity(updaterPid, 0, updaterStart)]),
      ],
      complete: true,
      stoppedBy: updaterStart > repairStart ? "recycled-parent" : "root",
    });

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
    readProcessIdentity.mockReturnValue(identity(repairPid, 0, replacementStart));
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
    readProcessIdentity.mockImplementation((pid) => identity(pid, 0, repairStart));
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
    readProcessIdentity.mockImplementation((pid) => identity(pid, 0, repairStart));

    expect(inspectUpdateRepairDriverAdmission([run(repairStart)], runId).kind).toBe("continuation");
    expect(readProcessAncestry).toHaveBeenCalledTimes(1);
    expect(inspectUpdateRepairDriverAdmission([run(repairStart)], runId).kind).toBe("continuation");

    // Retained proof is bound to the verified identity, never to a reused PID.
    const reusedStart = doctorStart + 1000;
    readProcessIdentity.mockImplementation((pid) => identity(pid, 0, reusedStart));
    expect(inspectUpdateRepairDriverAdmission([run(reusedStart)], runId)).toMatchObject({
      kind: "conflict",
      message: expect.stringContaining("could not read this process's ancestry"),
    });
  });

  it.each([{ requiredUpdater: true, expected: "conflict" }])(
    "requires readable ancestry through every live driver (updater required=$requiredUpdater)",
    ({ requiredUpdater, expected }) => {
      const currentPid = repairPid + 300 + Number(requiredUpdater);
      const previousPid = updaterPid + 500;
      readProcessAncestry.mockImplementation((_pid, options) => ({
        chain: [
          identity(process.pid, currentPid, doctorStart),
          identity(currentPid, previousPid, repairStart),
        ],
        complete: options?.throughPid === currentPid,
        stoppedBy: options?.throughPid === currentPid ? "through-pid" : "unreadable-parent",
      }));
      const run = updateRun();
      run.origin.driver = { host: hostname(), pid: currentPid, startIdentity: String(repairStart) };
      run.origin.previousDrivers = requiredUpdater
        ? [{ host: hostname(), pid: previousPid, startIdentity: String(originalStart) }]
        : [];
      readProcessIdentity.mockImplementation((pid) =>
        identity(pid, 0, pid === currentPid ? repairStart : originalStart),
      );
      expect(getSelfAndAncestorPidsSync().has(currentPid)).toBe(true);
      expect(inspectUpdateRepairDriverAdmission([run], runId).kind).toBe(expected);
    },
  );

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
      const parent = readBorrowedLegacyHandoffParent("/synthetic-install", row, {
        pid: repairPid,
        startIdentity: String(repairStart),
      });
      if (!parent) {
        throw new Error("The fixture requires its recorded helper custody");
      }
      readProcessAncestry.mockImplementation((_pid, options) => ({
        chain: [
          identity(process.pid, repairPid, doctorStart),
          identity(repairPid, updaterPid, repairStart),
          ...(fault === "unreadable-helper"
            ? []
            : [identity(updaterPid, updaterPid + 1, originalStart)]),
        ],
        complete: fault !== "unreadable-helper" && options?.throughPid === updaterPid,
        stoppedBy:
          fault !== "unreadable-helper" && options?.throughPid === updaterPid
            ? "through-pid"
            : "unreadable-parent",
      }));
      if (fault === "reused-helper") {
        readProcessIdentity.mockImplementation((pid) =>
          pid === repairPid
            ? identity(repairPid, updaterPid, repairStart)
            : identity(updaterPid, 0, originalStart + 1),
        );
      }
      const current = fault === "replaced-row" ? { ...row, owner: "replacement" } : row;
      expect(
        isBorrowedLegacyHandoffParentCurrent(
          parent,
          () => current,
          createManagedHandoffProcessIdentityReader({ env: {} }),
        ),
      ).toBe(fault === "current");
    },
  );
});

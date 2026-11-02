import { expect, it } from "vitest";
import { decideDatabaseSnapshot } from "./update-database-snapshot-custody.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { createUpdateRunRecordFixture } from "./update-run-record.test-support.js";
import { isGitDatabaseSnapshotName } from "./update-runtime-staging.js";

// Which run captured a snapshot is found in the real store by the earlier-artifacts sweep
// tests. These cases cover what each kind of run decides once it is known.
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY_MS;
const directory = "/repo/.artifacts/dist-runtime.openclaw-update-id.tmp.databases";
const captured = `Databases snapshotted at ${directory}. Verified successful activation removes these.`;

function run(
  status: UpdateRunRecord["status"],
  finishedDaysAgo: number | null,
  details: string[] = [captured],
  phases: string[] = ["requested", "activating"],
): UpdateRunRecord {
  return createUpdateRunRecordFixture(`${status}-${finishedDaysAgo}`, {
    status,
    finishedAtMs: finishedDaysAgo === null ? null : NOW - finishedDaysAgo * DAY_MS,
    steps: [
      ...phases.map((step) => ({ step, status: "completed" as const })),
      ...details.map((detail) => ({
        step: "diagnostic:database snapshot",
        status: "completed" as const,
        detail,
      })),
    ],
  });
}

const decide = (
  ageDays: number,
  capture?: UpdateRunRecord,
  latestSuccess?: UpdateRunRecord,
  holdsThisStateDatabase = true,
) =>
  decideDatabaseSnapshot(
    directory,
    ageDays * DAY_MS,
    { capture, latestSuccess },
    holdsThisStateDatabase,
    NOW,
  );

it.each([
  ["a succeeded run", run("succeeded", 1), undefined],
  ["a skipped run", run("skipped", 1), undefined],
  [
    "a failure that never activated",
    run("failed", 1, [captured], ["requested", "original-state-capture"]),
    undefined,
  ],
  [
    "a refused restoration after its window",
    run("succeeded", 8, [
      captured,
      `Automatic database restoration unavailable: x. Snapshots retained at ${directory}.`,
    ]),
    undefined,
  ],
  ["a failed run after a later success and its window", run("failed", 9), run("succeeded", 8)],
])("releases a snapshot for %s", (_label, capture, latestSuccess) => {
  expect(decide(30, capture, latestSuccess)).toHaveProperty("remove");
});

it.each([
  ["a run in progress", run("running", null), undefined],
  ["a failed activated run with no later success", run("failed", 30), undefined],
  ["a later success inside the recovery window", run("failed", 3), run("succeeded", 2)],
  ["an earlier success does not resolve a later failure", run("failed", 9), run("succeeded", 30)],
  [
    "a refused restoration inside its window",
    run("succeeded", 2, [
      captured,
      `Automatic database restoration is disabled because x. Snapshots remain available at ${directory}`,
    ]),
    undefined,
  ],
])("keeps a snapshot for %s, at any age", (_label, capture, latestSuccess) => {
  expect(decide(30, capture, latestSuccess)).toHaveProperty("keep");
});

it("keeps a snapshot when the history cannot be searched", () => {
  expect(decideDatabaseSnapshot(directory, 365 * DAY_MS, undefined, true, NOW)).toEqual({
    keep: "update history cannot show which run captured it",
  });
});

it("releases an old copy of this state's database that no run in the whole history records", () => {
  expect(decide(8)).toHaveProperty("remove");
  // The capture records its run only after copying, so a recent one may still be in progress.
  expect(decide(1)).toHaveProperty("keep");
});

it("keeps an unrecorded copy of another state directory's database, at any age", () => {
  expect(decide(365, undefined, undefined, false)).toHaveProperty("keep");
});

it("still follows the capturing run when the copy lacks this state's database", () => {
  expect(decide(1, run("succeeded", 1), undefined, false)).toHaveProperty("remove");
});

it.each([
  ["dist-runtime.openclaw-update-0000aaaa-0000-4000-8000-000000000000.tmp.databases", true],
  ["dist-runtime.openclaw-update-0000aaaa-0000-4000-8000-000000000000.tmp", false],
  ["operator-copy.databases", false],
  [".openclaw.package-backup-123.databases", false],
])("recognizes only Git staging snapshot names: %s", (name, expected) => {
  expect(isGitDatabaseSnapshotName(name)).toBe(expected);
});

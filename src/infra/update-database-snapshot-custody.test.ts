import { expect, it } from "vitest";
import { decideDatabaseSnapshot } from "./update-database-snapshot-custody.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { isGitDatabaseSnapshotName } from "./update-runtime-staging.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY_MS;
const directory = "/repo/.artifacts/dist-runtime.openclaw-update-id.tmp.databases";
const captured = `Databases snapshotted at ${directory}. Verified successful activation removes these.`;

function run(
  status: UpdateRunRecord["status"],
  finishedDaysAgo: number | null,
  details: string[] = [captured],
  steps: string[] = ["requested", "activating"],
): UpdateRunRecord {
  return {
    runId: `${status}-${finishedDaysAgo}`,
    status,
    finishedAtMs: finishedDaysAgo === null ? null : NOW - finishedDaysAgo * DAY_MS,
    origin: {},
    verification: {},
    repair: [],
    steps: [
      ...steps.map((step) => ({ step, status: "completed" })),
      ...details.map((detail) => ({
        step: "diagnostic:database snapshot",
        status: "completed",
        detail,
      })),
    ],
    // Only the fields this decision reads matter to it.
  } as unknown as UpdateRunRecord;
}

const decide = (ageDays: number, runs: UpdateRunRecord[], holdsThisStateDatabase = true) =>
  decideDatabaseSnapshot(directory, ageDays * DAY_MS, runs, holdsThisStateDatabase, NOW);

it.each([
  ["a succeeded run", [run("succeeded", 1)]],
  ["a skipped run", [run("skipped", 1)]],
  [
    "a failure that never activated",
    [run("failed", 1, [captured], ["requested", "original-state-capture"])],
  ],
  [
    "a refused restoration after its window",
    [
      run("succeeded", 8, [
        captured,
        `Automatic database restoration unavailable: x. Snapshots retained at ${directory}.`,
      ]),
    ],
  ],
  ["an old copy no run records", []],
  [
    "a failed run after a later success and its window",
    [run("failed", 9), run("succeeded", 8, ["other"])],
  ],
])("releases a snapshot for %s", (_label, runs) => {
  expect(decide(30, runs)).toHaveProperty("remove");
});

it.each([
  ["a run in progress", [run("running", null)]],
  ["a failed activated run with no later success", [run("failed", 30)]],
  [
    "a later success inside the recovery window",
    [run("failed", 3), run("succeeded", 2, ["other"])],
  ],
  [
    "an earlier success does not resolve a later failure",
    [run("succeeded", 30, ["other"]), run("failed", 9)],
  ],
  [
    "a refused restoration inside its window",
    [
      run("succeeded", 2, [
        captured,
        `Automatic database restoration is disabled because x. Snapshots remain available at ${directory}`,
      ]),
    ],
  ],
])("keeps a snapshot for %s, at any age", (_label, runs) => {
  expect(decide(30, runs)).toHaveProperty("keep");
});

it.each([
  ["failed before activating", "failed", ["requested", "original-state-capture"]],
  ["succeeded", "succeeded", ["requested", "activating"]],
] as const)(
  "is not released by a later run that only reported keeping it and %s",
  (_label, status, steps) => {
    const reported = `Runtime retained at ${directory}: recovery may need it`;
    // The capturing run failed after activating, and the later run did not resolve it inside the window.
    expect(decide(30, [run(status, 1, [reported], [...steps]), run("failed", 2)])).toHaveProperty(
      "keep",
    );
  },
);

it("keeps an unrecorded copy of another state directory's database, at any age", () => {
  expect(decide(365, [], false)).toHaveProperty("keep");
});

it("still follows the capturing run when the copy lacks this state's database", () => {
  expect(decide(1, [run("succeeded", 1)], false)).toHaveProperty("remove");
});

it("keeps a recent copy no run records, since capture records the run only when it ends", () => {
  expect(decide(1, [run("succeeded", 1, ["unrelated"])])).toHaveProperty("keep");
});

it.each([
  ["dist-runtime.openclaw-update-0000aaaa-0000-4000-8000-000000000000.tmp.databases", true],
  ["dist-runtime.openclaw-update-0000aaaa-0000-4000-8000-000000000000.tmp", false],
  ["operator-copy.databases", false],
  [".openclaw.package-backup-123.databases", false],
])("recognizes only Git staging snapshot names: %s", (name, expected) => {
  expect(isGitDatabaseSnapshotName(name)).toBe(expected);
});

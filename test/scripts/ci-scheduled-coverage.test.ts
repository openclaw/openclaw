import assert from "node:assert/strict";
import { matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import { createEveryFileTestMatrix } from "../../scripts/ci-scheduled-test-plan.mts";
import { decodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import { SCHEDULED_COVERAGE_EXCEPTIONS } from "../../scripts/lib/ci-node-test-inventory.mts";
import {
  listScheduledTestFiles,
  listUnscheduledTestFiles,
} from "../../scripts/lib/ci-scheduled-coverage.mts";
import { listGitTrackedFiles } from "../../src/test-utils/repo-files.js";

function listTrackedTests(): string[] {
  const files = listGitTrackedFiles({ pathspecs: "." });
  assert.ok(files !== null, "Scheduled coverage requires the Git-tracked inventory");
  return files.filter((file) => /\.test\.(?:tsx?|mts|mjs|cjs|py)$/u.test(file));
}

function isExcepted(file: string): boolean {
  return SCHEDULED_COVERAGE_EXCEPTIONS.some(({ pattern }) => matchesGlob(file, pattern));
}

describe("scheduled test coverage", () => {
  it("accounts for every tracked test without leaking covered or excepted files into the daily lane", () => {
    const tracked = listTrackedTests();
    expect(tracked.length).toBeGreaterThan(0);
    const trackedSet = new Set(tracked);
    const scheduled = new Set(listScheduledTestFiles());
    const everyFile = listUnscheduledTestFiles();
    const everyFileSet = new Set(everyFile);

    expect(
      tracked.filter(
        (file) => !scheduled.has(file) && !everyFileSet.has(file) && !isExcepted(file),
      ),
    ).toEqual([]);
    expect(
      everyFile.filter((file) => !trackedSet.has(file) || scheduled.has(file) || isExcepted(file)),
    ).toEqual([]);

    for (const exception of SCHEDULED_COVERAGE_EXCEPTIONS) {
      expect(exception.owner.trim(), exception.pattern).not.toBe("");
      expect(exception.reason.trim(), exception.pattern).not.toBe("");
      expect(
        tracked.some((file) => matchesGlob(file, exception.pattern)),
        `Stale scheduled coverage exception: ${exception.pattern}`,
      ).toBe(true);
    }
  });

  it("packs every unscheduled file exactly once as an explicit runner include", () => {
    const actual: string[] = [];
    for (const row of createEveryFileTestMatrix().include) {
      const groups = decodeNodeTestGroups(row.groups_gzip_base64);
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        assert.ok(typeof group === "object" && group !== null && "includePatterns" in group);
        const patterns = group.includePatterns;
        assert.ok(Array.isArray(patterns), "Daily groups must use explicit file includes");
        expect(patterns.length).toBeGreaterThan(0);
        for (const file of patterns) {
          assert.equal(typeof file, "string");
          actual.push(file);
        }
      }
    }

    expect(actual.toSorted()).toEqual(listUnscheduledTestFiles().toSorted());
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("keeps live and non-Vitest tests out of the secretless every-file lane", () => {
    const restricted = listTrackedTests().filter(
      (file) => !/\.test\.(?:tsx?|mts)$/u.test(file) || /\.live\.test\./u.test(file),
    );
    const scheduled = new Set(listScheduledTestFiles());
    const everyFile = new Set(listUnscheduledTestFiles());

    expect(restricted.filter((file) => everyFile.has(file))).toEqual([]);
    expect(restricted.filter((file) => !scheduled.has(file) && !isExcepted(file))).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildFindRunArgs,
  classifyRollup,
  classifyRunAttachment,
  parseArgs,
  selectRunAfter,
} from "../../scripts/watch-pr-ci.mjs";

const sha = "a".repeat(40);

describe("watch-pr-ci", () => {
  it("parses defaults and overrides", () => {
    expect(parseArgs(["42", sha])).toEqual({
      pr: 42,
      headSha: sha,
      repo: "openclaw/openclaw",
      attachTimeout: 900,
      timeout: 3600,
      interval: 120,
    });
    expect(
      parseArgs([
        "7",
        sha,
        "--repo",
        "fork/project",
        "--after",
        "1234",
        "--attach-timeout",
        "30",
        "--timeout",
        "90",
        "--interval",
        "5",
      ]),
    ).toMatchObject({
      repo: "fork/project",
      after: 1234,
      attachTimeout: 30,
      timeout: 90,
      interval: 5,
    });
    expect(parseArgs(["1", sha.toUpperCase()]).headSha).toBe(sha);
  });

  it("rejects malformed arguments", () => {
    expect(() => parseArgs(["0", sha])).toThrow("pr-number must be a positive integer");
    expect(() => parseArgs(["1", "abc"])).toThrow("full 40-character commit SHA");
    expect(() => parseArgs(["1", sha, "--interval", "0"])).toThrow(
      "--interval must be a positive integer",
    );
    expect(() => parseArgs(["1", sha, "--after", "0"])).toThrow(
      "--after must be a positive integer",
    );
  });

  it("builds a pull-request-only run attachment query", () => {
    expect(buildFindRunArgs("openclaw/openclaw", sha)).toEqual([
      "run",
      "list",
      "--repo",
      "openclaw/openclaw",
      "--commit",
      sha,
      "--workflow",
      "ci.yml",
      "--event",
      "pull_request",
      "--limit",
      "1",
      "--json",
      "createdAt,databaseId",
    ]);
  });

  it("filters run ids at and before --after", () => {
    const newer = { databaseId: 102, createdAt: "2026-07-23T02:00:00Z" };
    const runs = [newer, { databaseId: 101, createdAt: "2026-07-23T01:00:00Z" }];
    expect(selectRunAfter(runs, 101)).toBe(newer);
    expect(selectRunAfter(runs, 102)).toBeUndefined();
    expect(selectRunAfter(runs)).toBe(newer);
  });

  it("warns for an already-completed late attachment without changing attachment", () => {
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "success" })).toEqual({
      attach: true,
      warning:
        "WARN attaching to already-completed run 102 (started before watcher); pass --after 102 to require a fresh run",
    });
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "success" }, 101)).toEqual(
      { attach: true, warning: undefined },
    );
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "skipped" })).toEqual({
      attach: false,
    });
  });

  it("requires aggregate success for a green rollup", () => {
    expect(classifyRollup({ state: "SUCCESS", contexts: { nodes: [] } }).verdict).toBe("GREEN");
    expect(
      classifyRollup({
        state: "PENDING",
        contexts: {
          nodes: [{ kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 0, failingNames: [] });
  });

  it("counts pending contexts without deriving the verdict from them", () => {
    expect(
      classifyRollup({
        state: "PENDING",
        contexts: {
          nodes: [{ kind: "CheckRun", name: "unit", status: "IN_PROGRESS", conclusion: null }],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 1, failingNames: [] });
  });

  it.each(["FAILURE", "ERROR"])(
    "classifies stale same-name cancellations for aggregate %s",
    (state) => {
      expect(
        classifyRollup({
          state,
          contexts: {
            totalCount: 3,
            nodes: [
              {
                kind: "CheckRun",
                name: "Auto response",
                status: "COMPLETED",
                conclusion: "FAILURE",
              },
              { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
              { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
            ],
          },
        }),
      ).toEqual({ verdict: "STALE-CANCELLED", pendingCount: 0, failingNames: ["unit"] });
    },
  );

  it("does not soften a truncated failing rollup to stale-cancelled", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          totalCount: 4,
          nodes: [
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["unit", "+2 more contexts not shown"],
    });
  });

  it("keeps cancelled attempts in failing-name output", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            { kind: "CheckRun", name: "Auto response", status: "COMPLETED", conclusion: "FAILURE" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
            { kind: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT" },
          ],
        },
      }),
    ).toEqual({ verdict: "FAILING", pendingCount: 0, failingNames: ["lint", "unit"] });
  });
});

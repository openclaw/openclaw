import { describe, expect, it } from "vitest";
import {
  buildCiDispatchArgs,
  dispatchCiForPr,
  formatCiDispatchCommand,
} from "../../scripts/pr-lib/ci-dispatch.mjs";

describe("scripts/pr ci-dispatch", () => {
  it("constructs the exact CI workflow dispatch for the remote PR head", () => {
    const record = {
      pr: 12345,
      headRefName: "contributor/fix-hosted-gates",
      headRefOid: "0123456789abcdef0123456789abcdef01234567",
      isCrossRepository: false,
    };

    expect(buildCiDispatchArgs(record)).toEqual([
      "workflow",
      "run",
      "ci.yml",
      "--ref",
      "contributor/fix-hosted-gates",
      "-f",
      "target_ref=0123456789abcdef0123456789abcdef01234567",
      "-f",
      "release_gate=true",
      "-f",
      "pull_request_number=12345",
    ]);
    expect(formatCiDispatchCommand(record)).toBe(
      "gh workflow run ci.yml --ref contributor/fix-hosted-gates -f target_ref=0123456789abcdef0123456789abcdef01234567 -f release_gate=true -f pull_request_number=12345",
    );
  });

  it("refuses a fork-local branch name", () => {
    expect(() =>
      buildCiDispatchArgs({
        pr: 12345,
        headRefName: "fix-hosted-gates",
        headRefOid: "0123456789abcdef0123456789abcdef01234567",
        isCrossRepository: true,
      }),
    ).toThrow(/comes from a fork/u);
  });

  it("keeps a successful dispatch successful while run indexing is pending", async () => {
    const record = {
      pr: 12345,
      headRefName: "fix-hosted-gates",
      headRefOid: "0123456789abcdef0123456789abcdef01234567",
      isCrossRepository: false,
    };
    const dispatched: string[][] = [];

    await expect(
      dispatchCiForPr(record, {
        pollAttempts: 2,
        pollIntervalMs: 0,
        listRuns: () => [],
        runDispatch: (args) => dispatched.push(args),
        readHeadOid: () => record.headRefOid,
        wait: async () => {},
      }),
    ).resolves.toBeUndefined();
    expect(dispatched).toEqual([buildCiDispatchArgs(record)]);
  });

  it("fails closed if the remote PR head changes while the dispatch is indexed", async () => {
    const record = {
      pr: 12345,
      headRefName: "fix-hosted-gates",
      headRefOid: "0123456789abcdef0123456789abcdef01234567",
      isCrossRepository: false,
    };
    const heads = [record.headRefOid, "fedcba9876543210fedcba9876543210fedcba98"];

    await expect(
      dispatchCiForPr(record, {
        pollAttempts: 1,
        listRuns: () => [],
        runDispatch: () => {},
        readHeadOid: () => heads.shift(),
        wait: async () => {},
      }),
    ).rejects.toThrow(/head changed while CI dispatch was being indexed/u);
  });

  it("rechecks the remote head before returning a newly observed exact-SHA run", async () => {
    const record = {
      pr: 12345,
      headRefName: "fix-hosted-gates",
      headRefOid: "0123456789abcdef0123456789abcdef01234567",
      isCrossRepository: false,
    };
    const observedRun = {
      databaseId: 99,
      headSha: record.headRefOid,
      url: "https://github.com/openclaw/openclaw/actions/runs/99",
    };
    const runLists = [[], [observedRun]];
    let headReads = 0;

    await expect(
      dispatchCiForPr(record, {
        pollAttempts: 1,
        listRuns: () => runLists.shift() ?? [],
        runDispatch: () => {},
        readHeadOid: () => {
          headReads += 1;
          return record.headRefOid;
        },
        wait: async () => {},
      }),
    ).resolves.toBe(observedRun);
    expect(headReads).toBe(2);
  });
});

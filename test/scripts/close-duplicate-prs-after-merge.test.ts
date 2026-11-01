import { expect, it, vi } from "vitest";
import {
  defaultRunGh,
  parseArgs,
  parseUnifiedDiffRanges,
  runDuplicateCloseWorkflow,
} from "../../scripts/close-duplicate-prs-after-merge.mjs";

const repo = "openclaw/openclaw";
const diff = (hunk: string) => `diff --git a/a.ts b/a.ts\n${hunk}`;
const pr = (number: number, body = "") => ({
  number,
  body,
  state: "OPEN",
  files: [{ path: "a.ts" }],
});
const landed = {
  ...pr(2, "Fixes #42"),
  state: "MERGED",
  mergedAt: "2026-04-23",
  mergeCommit: { oid: "6415e35" },
};

it("parses separate files and implicit/explicit hunk lengths", () => {
  const ranges = parseUnifiedDiffRanges(`${diff("@@ -10,2 +20,4 @@\n+x")}
diff --git a/b.ts b/b.ts
@@ -1 +5 @@
-a
+b`);
  expect(ranges.get("a.ts")).toEqual([{ start: 20, end: 23 }]);
  expect(ranges.get("b.ts")).toEqual([{ start: 5, end: 5 }]);
});

it.each([
  { issue: false, overlap: true, apply: false },
  { issue: true, overlap: false, apply: false },
  { issue: false, overlap: false, apply: true },
  { issue: true, overlap: false, apply: true },
])("requires duplicate evidence before mutation: %j", ({ issue, overlap, apply }) => {
  const runGh = vi
    .fn()
    .mockReturnValueOnce(JSON.stringify(landed))
    .mockReturnValueOnce(JSON.stringify(pr(1, issue ? "Closes #42" : "")))
    .mockReturnValueOnce(diff("@@ -1 +1 @@"))
    .mockReturnValueOnce(diff(overlap ? "@@ -1 +1 @@" : "@@ -99 +99 @@"));
  const args = parseArgs(
    [
      "--landed-pr",
      "2",
      "--duplicates",
      "#1, 1\n1",
      "--labels",
      "duplicate,close:duplicate",
      ...(apply ? ["--apply"] : []),
    ],
    { GITHUB_REPOSITORY: repo },
  );
  expect(args.duplicates).toEqual([1]);
  const run = () => runDuplicateCloseWorkflow(args, runGh);
  if (!issue && !overlap) {
    expect(run).toThrow("Refusing to close #1");
    expect(runGh).toHaveBeenCalledTimes(4);
    return;
  }
  const plan = run();
  expect(plan).toHaveLength(1);
  expect(plan[0]).toMatchObject({
    action: "close",
    comment: expect.stringContaining(`https://github.com/${repo}/commit/6415e35`),
    evidence: { overlappingHunks: overlap, sharedFiles: ["a.ts"], sharedIssues: issue ? [42] : [] },
  });
  const target = ["1", "--repo", repo];
  expect(runGh.mock.calls.slice(4).map(([call]) => call)).toEqual(
    apply
      ? [
          ["pr", "edit", ...target, "--add-label", "duplicate", "--add-label", "close:duplicate"],
          ["pr", "comment", ...target, "--body", plan[0].comment],
          ["pr", "close", ...target],
        ]
      : [],
  );
});

it("bounds GitHub calls and prevents interactive stdin", () => {
  const args = ["pr", "view", "123"];
  const execFileSyncImpl = vi.fn(() => "result");
  expect(defaultRunGh(args, {}, { execFileSyncImpl })).toBe("result");
  expect(execFileSyncImpl).toHaveBeenCalledWith(
    "gh",
    args,
    expect.objectContaining({
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 60_000,
    }),
  );
});

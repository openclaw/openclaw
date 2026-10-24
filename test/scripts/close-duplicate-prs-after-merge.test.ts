import { expect, it, vi } from "vitest";
import {
  buildDuplicateClosePlan,
  defaultRunGh,
  parseArgs,
  parseUnifiedDiffRanges,
  runDuplicateCloseWorkflow,
} from "../../scripts/close-duplicate-prs-after-merge.mjs";

const repo = "openclaw/openclaw";
const file = "a.ts";
const diff = (hunk: string) => `diff --git a/${file} b/${file}\n${hunk}`;
const pr = (number: number, body = "") => ({
  number,
  body,
  state: "OPEN",
  files: [{ path: file }],
});
const landed = {
  ...pr(2, "Fixes #42"),
  state: "MERGED",
  mergedAt: "2026-04-23T17:13:32Z",
  mergeCommit: { oid: "6415e35" },
};

it("parses multiple files and implicit/explicit hunk lengths", () => {
  expect(
    parseUnifiedDiffRanges(`${diff("@@ -10,2 +20,4 @@\n+x")}
diff --git a/b.ts b/b.ts
@@ -1 +5 @@
-a
+b`),
  ).toEqual(
    new Map([
      [file, [{ start: 20, end: 23 }]],
      ["b.ts", [{ start: 5, end: 5 }]],
    ]),
  );
});

it.each([true, false])("requires overlapping hunks without a shared issue: %s", (overlap) => {
  const candidate = pr(1);
  const plan = () =>
    buildDuplicateClosePlan({
      candidates: [candidate],
      landed,
      repo,
      diffs: new Map([
        [2, diff("@@ -1 +1 @@")],
        [1, diff(overlap ? "@@ -1 +1 @@" : "@@ -99 +99 @@")],
      ]),
    });
  if (!overlap) {
    expect(plan).toThrow("Refusing to close #1");
    return;
  }
  expect(plan()).toEqual([
    {
      action: "close",
      candidate,
      comment: expect.stringContaining(`https://github.com/${repo}/commit/6415e35`),
      evidence: { overlappingHunks: true, sharedFiles: [file], sharedIssues: [] },
    },
  ]);
});

it.each([false, true])("uses shared issues through the workflow (apply=%s)", (apply) => {
  const runGh = vi
    .fn()
    .mockReturnValueOnce(JSON.stringify(landed))
    .mockReturnValueOnce(JSON.stringify(pr(1, "Closes #42")))
    .mockReturnValueOnce(diff("@@ -1 +1 @@"))
    .mockReturnValueOnce(diff("@@ -99 +99 @@"))
    .mockReturnValue("");
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
  const plan = runDuplicateCloseWorkflow(args, runGh);
  expect(plan).toHaveLength(1);
  expect(plan[0]).toMatchObject({
    action: "close",
    evidence: { overlappingHunks: false, sharedFiles: [file], sharedIssues: [42] },
  });
  expect(runGh.mock.calls.slice(0, 4).map(([call]) => call.slice(0, 2))).toEqual([
    ["pr", "view"],
    ["pr", "view"],
    ["pr", "diff"],
    ["pr", "diff"],
  ]);
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

it.each([undefined, "body"])("bounds GitHub calls and forwards optional stdin: %s", (input) => {
  const args = ["pr", "view", "123"];
  const options = input ? { input } : {};
  const execFileSyncImpl = vi.fn(() => "result");
  expect(defaultRunGh(args, options, { execFileSyncImpl })).toBe("result");
  expect(execFileSyncImpl).toHaveBeenCalledWith(
    "gh",
    args,
    expect.objectContaining({
      ...options,
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: [input ? "pipe" : "ignore", "pipe", "inherit"],
      timeout: 60_000,
    }),
  );
});

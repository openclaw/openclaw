import { describe, expect, it, vi } from "vitest";
import {
  applyClosePlan,
  buildDuplicateClosePlan,
  defaultRunGh,
  parseArgs,
  parsePrNumberList,
  parseUnifiedDiffRanges,
  runDuplicateCloseWorkflow,
} from "../../scripts/close-duplicate-prs-after-merge.mjs";

const repo = "openclaw/openclaw";
const sourceFile = "ui/src/ui/chat/grouped-render.ts";
const diff = (hunk: string, file = sourceFile) => `diff --git a/${file} b/${file}\n${hunk}`;
function pr(number: number, body = "") {
  return {
    body,
    closingIssuesReferences: [],
    files: [{ path: sourceFile }],
    mergeCommit: null,
    mergedAt: null,
    number,
    state: "OPEN",
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
  };
}
const landed = {
  ...pr(70532, "Fixes #70491"),
  mergeCommit: { oid: "6415e35" },
  mergedAt: "2026-04-23T17:13:32Z",
  state: "MERGED",
};
function closePlan(candidate: ReturnType<typeof pr>, diffs: Map<number, string>) {
  return buildDuplicateClosePlan({ candidates: [candidate], diffs, landed, repo });
}

describe("close duplicate PRs after merge", () => {
  it("parses comma, whitespace, and hash-prefixed PR lists", () => {
    expect(parsePrNumberList("#70530, 70592\n70530")).toEqual([70530, 70592]);
  });

  it("parses hunk ranges from unified diffs", () => {
    const ranges = parseUnifiedDiffRanges(`diff --git a/a.ts b/a.ts
@@ -10,2 +20,4 @@
+x
diff --git a/b.ts b/b.ts
@@ -1 +5 @@
-a
+b`);
    expect(ranges.get("a.ts")).toEqual([{ start: 20, end: 23 }]);
    expect(ranges.get("b.ts")).toEqual([{ start: 5, end: 5 }]);
  });

  it("allows duplicate closure with overlapping hunks even without an explicit issue ref", () => {
    const candidate = pr(70530);
    const diffs = new Map([
      [70532, diff("@@ -402,8 +402,11 @@")],
      [70530, diff("@@ -402,8 +402,11 @@")],
    ]);
    const plan = closePlan(candidate, diffs);
    expect(plan).toStrictEqual([
      {
        action: "close",
        candidate,
        comment: `Thanks for the fix. This is now covered by the landed #70532 / commit https://github.com/openclaw/openclaw/commit/6415e35.

Evidence: overlapping changed hunks; shared file(s): ui/src/ui/chat/grouped-render.ts.

Closing #70530 as a duplicate.`,
        evidence: {
          overlappingHunks: true,
          sharedFiles: [sourceFile],
          sharedIssues: [],
        },
      },
    ]);
  });

  it("refuses candidates without shared issue or overlapping hunks", () => {
    const candidate = pr(1, "Fixes #1");
    const diffs = new Map([
      [70532, diff("@@ -1 +1 @@", "a.ts")],
      [1, diff("@@ -99 +99 @@", "a.ts")],
    ]);
    expect(() => closePlan(candidate, diffs)).toThrow("Refusing to close #1");
  });

  it("dry-runs through gh reads without mutating", () => {
    const calls: string[][] = [];
    const viewFlags = `--repo ${repo} --json number,title,body,state,mergedAt,mergeCommit,closingIssuesReferences,files,url`;
    const responses = new Map<string, string>([
      [`pr view 70532 ${viewFlags}`, JSON.stringify(landed)],
      [`pr view 70592 ${viewFlags}`, JSON.stringify(pr(70592, "Closes #70491"))],
      [`pr diff 70532 --repo ${repo} --color=never`, diff("@@ -402,8 +402,11 @@")],
      [`pr diff 70592 --repo ${repo} --color=never`, diff("@@ -286,8 +286,11 @@")],
    ]);
    const runGh = (args: string[]) => {
      calls.push(args);
      const key = args.join(" ");
      const response = responses.get(key);
      if (response === undefined) {
        throw new Error(`unexpected gh call: ${key}`);
      }
      return response;
    };
    const args = parseArgs(["--landed-pr", "70532", "--duplicates", "70592"], {
      GITHUB_REPOSITORY: repo,
    });
    const plan = runDuplicateCloseWorkflow(args, runGh);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      action: "close",
      evidence: {
        overlappingHunks: false,
        sharedFiles: [sourceFile],
        sharedIssues: [70491],
      },
    });
    expect(calls.map((call) => call.slice(0, 2).join(" "))).toEqual([
      "pr view",
      "pr view",
      "pr diff",
      "pr diff",
    ]);
  });

  it("applies labels, comment, and close commands for close actions", () => {
    const calls: string[][] = [];
    applyClosePlan({
      labels: ["duplicate", "close:duplicate"],
      plan: [
        {
          action: "close",
          candidate: pr(70592),
          comment: "closing",
          evidence: { overlappingHunks: false, sharedFiles: [], sharedIssues: [70491] },
        },
      ],
      repo,
      runGh: (args: string[]) => {
        calls.push(args);
        return "";
      },
    });
    const target = ["70592", "--repo", repo];
    expect(calls).toEqual([
      ["pr", "edit", ...target, "--add-label", "duplicate", "--add-label", "close:duplicate"],
      ["pr", "comment", ...target, "--body", "closing"],
      ["pr", "close", ...target],
    ]);
  });
});

describe("defaultRunGh", () => {
  it.each([undefined, "body"])("bounds GitHub calls and forwards optional stdin: %s", (input) => {
    const args = input ? ["pr", "edit", "123", "--add-label", "duplicate"] : ["pr", "view", "123"];
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
});

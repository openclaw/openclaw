import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as worktreeGit from "../agents/worktrees/git.js";
import { withGitWorkerContext } from "../infra/git-worker-context.js";
import {
  readCheckoutGitRevision,
  readPullRequestBranchFacts,
} from "./control-ui-session-prs-git.runtime.js";
import { resolveBranchLanding } from "./control-ui-session-prs-landing.js";

const execFileAsync = promisify(execFile);

describe("resolveBranchLanding", () => {
  let root: string;

  const git = (...args: string[]) =>
    execFileAsync("git", ["-c", "user.email=test@openclaw.ai", "-c", "user.name=Test", ...args], {
      cwd: root,
    });
  const sha = async (ref: string) => (await git("rev-parse", ref)).stdout.trim();
  const land = (mergedHeads: Parameters<typeof resolveBranchLanding>[1]["mergedHeads"] = []) =>
    resolveBranchLanding(root, { branch: "feature", defaultBranch: "main", mergedHeads });
  const commitFile = async (file: string, text: string, message: string, append = false) => {
    await (append ? fs.appendFile : fs.writeFile)(path.join(root, file), text);
    await git("add", file);
    await git("commit", "-m", message);
  };
  const feature = async () => {
    await git("checkout", "-b", "feature");
    await commitFile("a.txt", "two\n", "feature work", true);
  };
  const expectedLanding = (base: string, pushedSha: string | null = null) => ({
    complete: true,
    pushedSha,
    defaultSha: base,
    statsBase: base,
    hasLandedPullRequest: false,
    provenNewPushedWork: false,
  });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prs-landing-")));
    await git("init", "--initial-branch=main", ".");
    await commitFile("a.txt", "one\n", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads packed HEAD once while preparing a checkout revision", async () => {
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await git("pack-refs", "--all", "--prune");
    const opens = vi.spyOn(fsSync, "openSync");
    const revision = await withGitWorkerContext(
      {
        consumeInput() {},
        notify() {},
        async request() {
          throw new Error("The file-backed revision must not invoke Git");
        },
      },
      () => readCheckoutGitRevision({ root, scope: "context" }),
      "fixture-environment",
    );

    expect(revision).not.toBeNull();
    expect(JSON.parse(revision!.key).slice(0, 4)).toEqual([
      { branch: "main", refsBase: path.join(root, ".git") },
      "origin/main",
      [],
      [],
    ]);
    expect(
      opens.mock.calls.filter(([file]) => file === path.join(root, ".git", "HEAD")),
    ).toHaveLength(1);
    expect(
      opens.mock.calls.filter(([file]) => file === path.join(root, ".git", "packed-refs")).length,
    ).toBeLessThanOrEqual(3);
  });

  it.each([0, 100, 101, 10_000])(
    "counts %i untracked files without materializing names beyond the content limit",
    async (count) => {
      const suffix = process.platform === "win32" ? ".txt" : "\n.txt";
      const names = Array.from({ length: count }, (_, index) => ` file-${index}${suffix}`);
      const inventory = names.length ? `${names.join("\0")}\0` : "";
      for (const name of names.slice(0, 100)) {
        await fs.writeFile(path.join(root, name), "one\ntwo");
      }
      const runGit = worktreeGit.runGit;
      vi.spyOn(worktreeGit, "runGit").mockImplementation(async (...args) => {
        const result = await runGit(...args);
        return args[1][0] === "ls-files" ? { ...result, stdout: inventory } : result;
      });
      const split = vi.spyOn(String.prototype, "split");
      const result = await readPullRequestBranchFacts({
        root,
        branch: "main",
        mergedHeads: [],
        comparison: {
          complete: true,
          statsBase: "HEAD",
          creatable: true,
          equalPushedTips: false,
        },
      });
      const materialized = split.mock.results.reduce((total, call, index) => {
        return split.mock.contexts[index] === inventory && call.type === "return"
          ? Math.max(total, call.value.length)
          : total;
      }, 0);
      split.mockRestore();

      expect(result).toEqual({
        creatable: true,
        stats: { additions: Math.min(count, 100) * 2, deletions: 0, changedFiles: count },
      });
      expect(materialized).toBeLessThanOrEqual(101);
    },
  );

  it.each(["unrelated descendant", "other base", "unavailable merged head"])(
    "resolves an unpublished branch with %s against captured revisions",
    async (scenario) => {
      const base = await sha("HEAD");
      await feature();
      if (scenario === "unrelated descendant") {
        await git("update-ref", "refs/remotes/origin/feature/child", "HEAD");
      }
      const unavailable = scenario === "unavailable merged head";
      const mergedHeads =
        scenario === "unrelated descendant"
          ? []
          : [{ sha: "1".repeat(40), baseRef: unavailable ? "main" : "release" }];
      expect(await land(mergedHeads)).toEqual({
        ...expectedLanding(base),
        complete: !unavailable,
        hasLandedPullRequest: unavailable,
      });
    },
  );

  it.each(["malformed selected", "missing selected object"])(
    "preserves readable revisions with a %s ref without fetching objects",
    async (scenario) => {
      const base = await sha("HEAD");
      const missingObject = "1".repeat(base.length);
      const missingSelectedObject = scenario === "missing selected object";
      await fs.writeFile(
        path.join(root, ".git", "refs", "remotes", "origin", "feature"),
        `${missingSelectedObject ? missingObject : "not-an-object-id"}\n`,
      );
      await git("config", "extensions.partialClone", "origin");
      await git("config", "remote.origin.promisor", "true");
      await git("config", "remote.origin.url", path.join(root, "missing-remote"));
      const tracePath = path.join(root, "git-trace.jsonl");
      vi.stubEnv("GIT_TRACE2_EVENT", tracePath);
      await expect(land()).resolves.toEqual({
        ...expectedLanding(base),
        pushedSha: missingSelectedObject ? missingObject : null,
      });
      const trace = await fs.readFile(tracePath, "utf8");
      expect(trace.split("\n").filter((line) => line.includes('"event":"child_start"'))).toEqual(
        [],
      );
    },
  );

  it("preserves complete revisions when a batch exceeds its output limit", async () => {
    const base = await sha("HEAD");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const runGit = worktreeGit.runGit;
    vi.spyOn(worktreeGit, "runGit").mockImplementationOnce(async (...args) => ({
      ...(await runGit(...args)),
      stdout: "truncated ref output",
      stdoutTruncatedBytes: 1,
    }));
    await expect(land()).resolves.toEqual(expectedLanding(base, base));
  });

  it("marks a squash-landed tip and bases stats on the merged head", async () => {
    await feature();
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = await sha("HEAD");

    expect(await land([{ sha: mergedHead, baseRef: "main" }])).toEqual({
      ...expectedLanding(await sha("refs/remotes/origin/main"), mergedHead),
      statsBase: mergedHead,
      hasLandedPullRequest: true,
    });
  });

  it.each(["duplicate", "distinct"])(
    "checks %s landing receipts per unique head",
    async (scenario) => {
      const base = await sha("HEAD");
      await feature();
      const mergedHead = await sha("HEAD");
      await git("checkout", "main");
      await commitFile("a.txt", "two\n", "squash land", true);
      const mergeCommit = await sha("HEAD");
      // A reset of main can land the same head without incorporating the older merge.
      let otherMerge = mergeCommit;
      if (scenario === "distinct") {
        const tree = (await git("write-tree")).stdout.trim();
        otherMerge = (
          await git("commit-tree", tree, "-p", base, "-m", "another landing")
        ).stdout.trim();
      }
      await git("update-ref", "refs/remotes/origin/main", "HEAD");
      await git("checkout", "feature");
      await git("reset", "--hard", "refs/remotes/origin/main");
      await commitFile("b.txt", "second\n", "second PR work");
      await git("update-ref", "refs/remotes/origin/feature", "HEAD");
      const head = await sha("HEAD");
      const runGit = vi.spyOn(worktreeGit, "runGit");
      const landedHead = { sha: mergedHead, baseRef: "main", mergeCommitSha: mergeCommit };

      const landing = await land([landedHead, { ...landedHead, mergeCommitSha: otherMerge }]);

      // The first squash remains the baseline even when another landing is missing.
      expect(landing).toMatchObject({
        provenNewPushedWork: scenario !== "distinct",
        statsBase: mergeCommit,
      });
      expect(
        runGit.mock.calls.filter(
          ([, args]) =>
            args[0] === "merge-base" &&
            args[1] === "--is-ancestor" &&
            args[2] === mergedHead &&
            args[3] === head,
        ),
      ).toHaveLength(1);
    },
  );

  it("selects the newest of three related baselines via the batched path", async () => {
    // Linear chain: merge base -> head1 -> head2 -> HEAD.
    const base = await sha("HEAD");
    await git("checkout", "-b", "feature");
    await commitFile("a.txt", "two\n", "pr1 work", true);
    const head1 = await sha("HEAD");
    await commitFile("a.txt", "three\n", "pr2 work", true);
    const head2 = await sha("HEAD");
    await commitFile("c.txt", "wip\n", "follow-up");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const runGit = vi.spyOn(worktreeGit, "runGit");

    const landing = await land([
      { sha: head1, baseRef: "main" },
      { sha: head2, baseRef: "main" },
    ]);

    expect(landing).toMatchObject({ statsBase: head2, hasLandedPullRequest: true });
    expect(runGit).not.toHaveBeenCalledWith(root, ["merge-base", "--is-ancestor", base, head2]);
  });
});

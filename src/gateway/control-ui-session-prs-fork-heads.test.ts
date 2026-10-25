import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  requestUrl,
  routedFetch,
} from "./control-ui-session-prs.test-support.js";

const { load } = createSessionPullRequestsFixture();
const branch = "t3/control-ui-elevated-identity-repro";
const forkOwner = "PratikRai0101";

describe("session PR fork head discovery", () => {
  const execFileAsync = promisify(execFile);
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  let templateRepo: string;
  let root: string;

  const gitIn = (cwd: string, ...args: string[]) =>
    execFileAsync("git", ["-c", "user.email=test@openclaw.ai", "-c", "user.name=Test", ...args], {
      cwd,
    });
  const git = (...args: string[]) => gitIn(root, ...args);

  const connectCheckout = async ({ trackForkRef }: { trackForkRef: boolean }) => {
    await git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await git("remote", "add", "fork", `https://github.com/${forkOwner}/openclaw.git`);
    await git("checkout", "-b", branch);
    if (trackForkRef) {
      await git("update-ref", `refs/remotes/fork/${branch}`, "HEAD");
    }
  };

  const openPull = (number: number, headRepository = { owner: forkOwner, repo: "openclaw" }) =>
    pullListItem({
      number,
      html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
      base: { ref: "main", repo: { name: "openclaw", owner: { login: "openclaw" } } },
      head: {
        sha: "b".repeat(40),
        ref: branch,
        repo: { full_name: `${headRepository.owner}/${headRepository.repo}` },
      },
    });

  const githubRoutes = (
    number: number,
    headRepository = { owner: forkOwner, repo: "openclaw" },
  ) => [
    {
      match: "/repos/openclaw/openclaw/pulls?head=openclaw%3A",
      response: () => githubJson([]),
    },
    {
      match: `/repos/openclaw/openclaw/pulls?head=${headRepository.owner}%3A`,
      response: () => githubJson([openPull(number, headRepository)]),
    },
    {
      match: `/repos/openclaw/openclaw/pulls/${number}`,
      response: () => githubJson({ additions: 4, deletions: 3, changed_files: 2 }),
    },
    {
      match: "/repos/openclaw/openclaw/commits/",
      response: () => githubJson({ total_count: 0, check_runs: [] }),
    },
    { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
  ];

  beforeAll(async () => {
    templateRepo = tempDirs.make("openclaw-session-prs-fork-template-");
    await gitIn(templateRepo, "init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(templateRepo, "a.txt"), "one\n");
    await gitIn(templateRepo, "add", "a.txt");
    await gitIn(templateRepo, "commit", "-m", "base");
  });

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-prs-fork-")),
    );
    await fs.cp(templateRepo, root, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports a fork head pull request while keeping the upstream repository identity", async () => {
    await connectCheckout({ trackForkRef: true });
    // Packed remote-tracking refs are the same evidence as loose ones.
    await git("pack-refs", "--all", "--prune");
    // The reported layout has no push or tracking configuration naming the fork.
    await expect(git("config", "--get", `branch.${branch}.pushRemote`)).rejects.toThrow();
    await expect(git("config", "--get", "remote.pushDefault")).rejects.toThrow();
    await expect(git("config", "--get", `branch.${branch}.remote`)).rejects.toThrow();

    const fetchImpl = routedFetch(githubRoutes(183696));
    vi.stubGlobal("fetch", fetchImpl);

    const result = await load(
      { sessionKey: "agent:main:main" },
      { resolveGitRoot: async () => root },
    );

    expect(result.repository).toEqual({ owner: "openclaw", repo: "openclaw" });
    expect(result.pullRequests.map((pull) => pull.number)).toEqual([183696]);
    expect(
      fetchImpl.mock.calls.some(([input]) => requestUrl(input).includes(`head=${forkOwner}%3A`)),
    ).toBe(true);
  });

  it("invalidates cached lookups when a fork ref or head repository changes", async () => {
    await connectCheckout({ trackForkRef: false });
    const fetchImpl = routedFetch(githubRoutes(183535));
    vi.stubGlobal("fetch", fetchImpl);

    const before = await load(
      { sessionKey: "agent:main:main" },
      { resolveGitRoot: async () => root },
    );
    expect(before.pullRequests).toEqual([]);

    await git("update-ref", `refs/remotes/fork/${branch}`, "HEAD");

    const after = await load(
      { sessionKey: "agent:main:main" },
      { resolveGitRoot: async () => root },
    );
    expect(after.pullRequests.map((pull) => pull.number)).toEqual([183535]);

    await git("remote", "set-url", "fork", `https://github.com/${forkOwner}/renamed-openclaw.git`);
    const changedRepository = await load(
      { sessionKey: "agent:main:main" },
      { resolveGitRoot: async () => root },
    );
    expect(changedRepository.pullRequests).toEqual([]);
  });

  it("finds a renamed fork without changing the base repository", async () => {
    await connectCheckout({ trackForkRef: true });
    await git("remote", "set-url", "fork", "https://github.com/lonexreb/paloa-claw.git");
    vi.stubGlobal(
      "fetch",
      routedFetch(githubRoutes(183571, { owner: "lonexreb", repo: "paloa-claw" })),
    );

    const result = await load(
      { sessionKey: "agent:main:main" },
      { resolveGitRoot: async () => root },
    );

    expect(result.repository).toEqual({ owner: "openclaw", repo: "openclaw" });
    expect(result.pullRequests.map((pull) => pull.number)).toEqual([183571]);
  });

  it("rejects a same-owner head from another repository", async () => {
    await connectCheckout({ trackForkRef: true });
    vi.stubGlobal(
      "fetch",
      routedFetch(githubRoutes(183696, { owner: forkOwner, repo: "another-repository" })),
    );

    const result = await load(
      { sessionKey: "agent:main:main" },
      { resolveGitRoot: async () => root },
    );

    expect(result.pullRequests).toEqual([]);
  });

  it("keeps a bounded set of same-host repository candidates tracking the branch", async () => {
    await connectCheckout({ trackForkRef: true });
    const remotes: Array<[name: string, url: string, tracksBranch: boolean]> = [
      ["zz-alt-a", "https://github.com/second-fork/openclaw.git", true],
      ["zz-alt-b", "https://github.com/third-fork/openclaw.git", true],
      ["zz-alt-c", "https://github.com/fourth-fork/openclaw.git", true],
      ["zz-alt-d", "https://github.com/fifth-fork/openclaw.git", true],
      ["renamed-fork", "https://github.com/renamed/contribution.git", true],
      ["not-github", "https://gitlab.com/someone/openclaw.git", true],
      ["same-owner", "https://github.com/openclaw/openclaw.git", true],
      ["untracked", "https://github.com/untracked/openclaw.git", false],
    ];
    for (const [name, url, tracksBranch] of remotes) {
      await git("remote", "add", name, url);
      if (tracksBranch) {
        await git("update-ref", `refs/remotes/${name}/${branch}`, "HEAD");
      }
    }

    const context = await runGitReadOperation({
      type: "checkout.context",
      input: { root },
    });

    expect(context).toMatchObject({
      owner: "openclaw",
      repo: "openclaw",
      branch,
      defaultBranch: "main",
    });
    expect(context?.forkHeadCandidates).toEqual([
      { owner: forkOwner, repo: "openclaw" },
      { owner: "renamed", repo: "contribution" },
      { owner: "second-fork", repo: "openclaw" },
    ]);
  });
});

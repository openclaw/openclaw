// Install the shared GitHub fixture before loading the registered action owners.
// oxfmt-ignore
import { interruptCanonicalWorkspaceAcceptance, bindFixtureRuntime, fixture, mocks } from "./github-pr-workspace-preparation.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { linkCanonicalUserProfileEmail } from "../state/user-profile-writes.js";
import {
  commandResult,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";

describe("imported PR source refresh", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each([false, true])(
    "recovers a pending refresh before a further PR head (bound runtime=%s)",
    async (boundRuntime) => {
      const f = await fixture();
      expect(await f.invoke()).toMatchObject({ status: "prepared", headCommit: f.headCommit });
      const runtime = boundRuntime ? await bindFixtureRuntime(f) : undefined;
      using _ = runtime?.projection;
      await fs.writeFile(path.join(f.projection, "artifact.txt"), "guest saved conflict\n");
      await fs.writeFile(path.join(f.projection, "untracked.txt"), "retained through recovery\n");
      // pr.txt is an imported file the guest has staged but not committed.
      const acceptedHead = await f.advanceHead({
        "artifact.txt": "remote PR change\n",
        "pr.txt": "remote PR update\n",
      });
      const { interruption, wasInterrupted } = interruptCanonicalWorkspaceAcceptance(
        "interrupted after canonical acceptance",
      );
      try {
        await expect(f.invoke()).rejects.toThrow("indeterminate and requires recovery");
      } finally {
        interruption.mockRestore();
      }
      expect(wasInterrupted()).toBe(true);
      expect(f.readSession().worktree?.githubPullRequest).toMatchObject({
        url: f.pr.html_url,
        head: { commit: acceptedHead },
        preparedHeadCommit: f.headCommit,
      });
      await f.advanceHead({ "newer-pr.txt": "remote advanced during recovery\n" });
      f.pr.base.ref = "new-destination";
      f.pr.base.sha = f.headCommit;
      if (boundRuntime) {
        expect(runtime?.isPaused()).toBe(true);
      } else {
        await closeOpenClawAgentDatabasesAsync();
      }
      expect(await f.invoke()).toMatchObject({
        status: "conflicts",
        headCommit: acceptedHead,
        headChanged: true,
        conflictPaths: ["artifact.txt"],
      });
      expect(runtime?.isPaused() ?? false).toBe(false);
      const conflict = await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8");
      expect(conflict).toContain("guest saved conflict");
      expect(conflict).toContain("remote PR change");
      expect(await fs.readFile(path.join(f.projection, "untracked.txt"), "utf8")).toBe(
        "retained through recovery\n",
      );
      await expect(fs.stat(path.join(f.projection, "newer-pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        f.invoke({ conflictsResolved: true, expectedHeadCommit: f.pr.head.sha }),
      ).rejects.toThrow("changed");
      await fs.writeFile(
        path.join(f.projection, "artifact.txt"),
        "remote PR change\nguest saved conflict\n",
      );
      // The pending refresh left the imported file staged at its pre-refresh bytes.
      expect(await f.guestGit("status", "--porcelain", "pr.txt")).toBe("AM pr.txt");
      const refreshEntry = await f.guestGit("rev-parse", ":pr.txt");
      // Staging a new version while the refresh is pending is guest work, not refresh output.
      const refreshed = await fs.readFile(path.join(f.projection, "pr.txt"));
      await fs.writeFile(path.join(f.projection, "pr.txt"), "staged-only guest work\n");
      await f.guestGit("add", "pr.txt");
      await fs.writeFile(path.join(f.projection, "pr.txt"), refreshed);
      await expect(
        f.invoke({ conflictsResolved: true, expectedHeadCommit: acceptedHead }),
      ).rejects.toThrow("Commit the staged changes");
      expect(await f.guestGit("show", ":pr.txt")).toBe("staged-only guest work");
      // A staged mode change on the same bytes is guest work too.
      await f.guestGit("update-index", "--cacheinfo", `100755,${refreshEntry},pr.txt`);
      await expect(
        f.invoke({ conflictsResolved: true, expectedHeadCommit: acceptedHead }),
      ).rejects.toThrow("Commit the staged changes");
      await f.guestGit("update-index", "--cacheinfo", `100644,${refreshEntry},pr.txt`);
      expect(
        await f.invoke({ conflictsResolved: true, expectedHeadCommit: acceptedHead }),
      ).toMatchObject({
        status: "prepared",
        headCommit: acceptedHead,
        headChanged: true,
        review: { mode: "local", base: f.headCommit },
      });
      expect(f.readSession().worktree?.githubPullRequest?.base.branch).toBe("new-destination");
      expect(f.readSession().worktree?.githubPullRequest?.preparedHeadCommit).toBe(acceptedHead);
      expect(await f.guestGit("show", ":pr.txt")).toBe("remote PR update");
      expect(await f.invoke()).toMatchObject({
        status: "prepared",
        headCommit: f.pr.head.sha,
        headChanged: false,
      });
      expect(await fs.readFile(path.join(f.projection, "newer-pr.txt"), "utf8")).toBe(
        "remote advanced during recovery\n",
      );
      expect(await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8")).toBe(
        "remote PR change\nguest saved conflict\n",
      );
      expect(f.readSession().worktree?.githubPullRequest?.preparedHeadCommit).toBe(f.pr.head.sha);
      expect(f.writes).toEqual([]);
    },
  );
  // GitHub serves the session's earlier publication as a PR authored by its managed publisher.
  async function ownBotPublishedPr() {
    const f = await fixture({ priorPublication: true });
    const published = f.priorPublication;
    if (published?.status !== "published") {
      throw new Error("The session did not publish its PR");
    }
    const upstreamGit = (...args: string[]) => f.local!.git("-C", f.upstream, ...args);
    await f.git("push", f.upstream, `${published.headCommit}:refs/heads/${published.branch}`);
    f.pr.user = { id: 42, login: "roboclaw-bot" };
    Object.assign(f.pr, {
      number: Number(published.url.split("/").at(-1)),
      html_url: published.url,
    });
    f.pr.head.ref = f.branch.name = published.branch;
    f.pr.head.sha = f.branch.commit.sha = published.headCommit;
    return { f, published, upstreamGit };
  }
  it("still refuses a bot-authored PR this session did not publish", async () => {
    const f = await fixture({ priorPublication: true });
    f.pr.user = { id: 42, login: "roboclaw-bot" };
    await expect(f.invoke()).rejects.toThrow("not authored by a GitHub account linked to you");
    expect(f.readSession().worktree?.githubPullRequest).toBeUndefined();
  });
  it("prepares its own unchanged bot-published PR after the base advances", async () => {
    const { f, published, upstreamGit } = await ownBotPublishedPr();
    await fs.writeFile(path.join(f.upstream, "base-later.txt"), "newer base\n");
    await upstreamGit("add", "base-later.txt");
    await upstreamGit("commit", "-m", "Newer base");
    f.pr.base.sha = await upstreamGit("rev-parse", "HEAD");
    expect(await f.invoke()).toMatchObject({
      status: "prepared",
      headCommit: published.headCommit,
      headChanged: false,
    });
    expect(f.readSession().worktree?.githubPullRequest).toMatchObject({
      url: published.url,
      preparedHeadCommit: published.headCommit,
    });
    expect(f.writes).toEqual([]);
  });
  // A maintainer appends to the PR branch outside the session, which holds an unpublished fix.
  async function advancedOwnBotPublishedPr() {
    const own = await ownBotPublishedPr();
    const { f, published, upstreamGit } = own;
    await upstreamGit("checkout", published.branch);
    await fs.writeFile(path.join(f.upstream, "maintainer.txt"), "maintainer follow-up\n");
    await upstreamGit("add", "maintainer.txt");
    await upstreamGit("commit", "-m", "Maintainer follow-up");
    const advanced = await upstreamGit("rev-parse", "HEAD");
    await upstreamGit("checkout", "main");
    f.pr.head.sha = f.branch.commit.sha = advanced;
    await fs.writeFile(path.join(f.projection, "artifact.txt"), "unpublished fix\n");
    return { ...own, advanced };
  }
  // Serve publication's GitHub reads and pushes from the upstream repository.
  function servePublishedRemote({
    f,
    published,
    upstreamGit,
  }: Awaited<ReturnType<typeof advancedOwnBotPublishedPr>>) {
    const pushes: string[] = [];
    const transport = mocks.runCommand.getMockImplementation()!;
    const json = (value: unknown) => commandResult(JSON.stringify(value));
    mocks.runCommand.mockImplementation(async (argv: string[], options) => {
      const endpoint = argv[0] === "gh" ? argv.find((arg) => arg.startsWith("repos/")) : undefined;
      if (argv.includes("push")) {
        const [commit, ref] = argv.at(-1)!.split(":");
        expect(ref).toBe(`refs/heads/${published.branch}`);
        expect(argv).toContain(`--force-with-lease=${ref}:${f.pr.head.sha}`);
        await f.git("push", f.upstream, `${commit}:${ref}`);
        pushes.push(commit!);
        f.pr.head.sha = f.branch.commit.sha = commit!;
        return commandResult();
      }
      if (argv.includes("ls-remote")) {
        return commandResult(`${f.pr.head.sha}\trefs/heads/${published.branch}\n`);
      }
      if (endpoint?.includes("/git/ref/")) {
        const ref = `refs/${endpoint.split("/git/ref/")[1]}`;
        return json({ ref, sha: await upstreamGit("rev-parse", ref) });
      }
      if (endpoint?.includes("/git/commits/")) {
        const sha = endpoint.split("/").at(-1)!;
        const parents = await upstreamGit("show", "-s", "--format=%P", sha);
        return json({
          sha,
          tree: { sha: await upstreamGit("rev-parse", `${sha}^{tree}`) },
          parents: parents.split(" ").map((parent) => ({ sha: parent })),
          message: await upstreamGit("show", "-s", "--format=%B", sha),
        });
      }
      if (endpoint?.endsWith(`/pulls/${f.pr.number}`) && argv.includes("--jq")) {
        return json({
          url: f.pr.html_url,
          userId: f.pr.user.id,
          state: f.pr.state,
          body: "",
          headSha: f.pr.head.sha,
          headRef: f.pr.head.ref,
          baseRef: f.pr.base.ref,
          headRepository: f.pr.head.repo.full_name,
          headRepositoryId: f.pr.head.repo.id,
          baseRepository: f.pr.base.repo.full_name,
          baseRepositoryId: f.pr.base.repo.id,
        });
      }
      return await transport(argv, options);
    });
    return pushes;
  }
  it("merges another writer's commits into this session's own bot-published PR", async () => {
    const own = await advancedOwnBotPublishedPr();
    const { f, published, upstreamGit, advanced } = own;

    expect(await f.invoke()).toMatchObject({ status: "prepared", headCommit: advanced });
    expect(await fs.readFile(path.join(f.projection, "maintainer.txt"), "utf8")).toBe(
      "maintainer follow-up\n",
    );
    expect(await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8")).toBe(
      "unpublished fix\n",
    );
    expect(await f.git("merge-base", "--is-ancestor", advanced, "HEAD")).toBe("");
    expect(f.writes).toEqual([]);

    // The saved fix publishes onto the same PR as a fast-forward of the maintainer's commit.
    const pushes = servePublishedRemote(own);
    const continued = await f.coordinator.requestForSessionV2(f.request("continue-pr", f.guest));
    expect(continued).toMatchObject({ status: "published", url: published.url });
    expect(pushes).toHaveLength(1);
    expect(await upstreamGit("merge-base", "--is-ancestor", advanced, pushes[0]!)).toBe("");
    expect(await upstreamGit("show", `${pushes[0]}:artifact.txt`)).toBe("unpublished fix");
  });
  it("refuses a revoked requester before accepting its own bot PR's newer head", async () => {
    const { f } = await advancedOwnBotPublishedPr();
    const head = await f.git("rev-parse", "HEAD");
    await f.revoke();
    await expect(f.invoke()).rejects.toThrow();
    expect(f.readSession().worktree?.githubPullRequest).toBeUndefined();
    expect(await f.git("rev-parse", "HEAD")).toBe(head);
    await expect(fs.stat(path.join(f.projection, "maintainer.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.writes).toEqual([]);
  });
  it("refuses a revoked requester before pushing to its own prepared bot PR", async () => {
    const own = await advancedOwnBotPublishedPr();
    const { f, published, upstreamGit, advanced } = own;
    expect(await f.invoke()).toMatchObject({ status: "prepared", headCommit: advanced });
    const pushes = servePublishedRemote(own);
    await f.revoke();
    await expect(
      f.coordinator.requestForSessionV2(f.request("continue-pr", f.guest)),
    ).rejects.toThrow("no longer authorized");
    expect(pushes).toEqual([]);
    expect(await upstreamGit("rev-parse", `refs/heads/${published.branch}`)).toBe(advanced);
  });
  it("preserves staged-only guest bytes and succeeds after the guest commits them", async () => {
    const f = await fixture();
    await f.invoke();
    await fs.writeFile(path.join(f.projection, "artifact.txt"), "staged guest version\n");
    await f.guestGit("add", "artifact.txt");
    await fs.writeFile(path.join(f.projection, "artifact.txt"), "base\n");
    const before = f.readSession().worktree?.githubPullRequest;
    const index = await f.guestGit("write-tree");
    await f.advanceHead({ "newer-pr.txt": "new remote work\n" });
    await expect(f.invoke()).rejects.toThrow("staged");
    expect(await f.guestGit("write-tree")).toBe(index);
    expect(await f.guestGit("show", ":artifact.txt")).toBe("staged guest version");
    expect(f.readSession().worktree?.githubPullRequest).toEqual(before);
    await f.guestGit("commit", "-m", "Preserve staged guest work");
    const guestHead = await f.guestGit("rev-parse", "HEAD");
    expect(await f.invoke()).toMatchObject({ status: "prepared", headCommit: f.pr.head.sha });
    expect(await f.guestGit("rev-parse", "HEAD")).toBe(guestHead);
    expect(await f.guestGit("show", "HEAD:artifact.txt")).toBe("staged guest version");
    expect(await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8")).toBe("base\n");
    expect(f.writes).toEqual([]);
  });
  it.each(["Stop", "role", "linked identity", "permission", "remote head"])(
    "preserves the imported source after %s during refresh",
    async (change) => {
      const f = await fixture({ fork: true });
      await f.invoke();
      await f.advanceHead({ "newer-pr.txt": "new remote work\n" });
      const before = f.readSession().worktree?.githubPullRequest;
      const head = await f.git("rev-parse", "HEAD");
      const controller = new AbortController();
      const transport = mocks.runCommand.getMockImplementation()!;
      let revoked = false;
      mocks.runCommand.mockImplementation(async (...args) => {
        const result = await transport(...args);
        if (!revoked && args[0].includes("fetch")) {
          revoked = true;
          if (change === "Stop") {
            controller.abort(new Error("refresh stopped"));
          } else if (change === "role") {
            await f.revoke();
          } else if (change === "permission") {
            f.pr.maintainer_can_modify = false;
          } else if (change === "remote head") {
            await f.advanceHead({ "later.txt": "advanced during source fetch\n" });
          } else {
            await linkCanonicalUserProfileEmail(
              "publication-guest@example.test",
              f.maintainerProfile,
            );
          }
        }
        return result;
      });
      await expect(f.invoke({}, f.sandbox, controller.signal)).rejects.toThrow();
      expect(revoked).toBe(true);
      expect(f.readSession().worktree?.githubPullRequest).toEqual(before);
      expect(await f.git("rev-parse", "HEAD")).toBe(head);
      await expect(fs.stat(path.join(f.projection, "newer-pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(f.writes).toEqual([]);
    },
  );

  it("refreshes a clean imported head and leaves a repeated acknowledgement unchanged", async () => {
    const f = await fixture({ empty: true });
    await f.invoke();
    const guestHead = await f.guestGit("rev-parse", "HEAD");
    const newHead = await f.advanceHead({ "newer-pr.txt": "new remote work\n" });
    expect(await f.invoke()).toMatchObject({
      status: "prepared",
      headCommit: newHead,
      conflictPaths: [],
    });
    for (const directory of [f.cwd, f.projection]) {
      expect(await fs.readFile(path.join(directory, "newer-pr.txt"), "utf8")).toBe(
        "new remote work\n",
      );
    }
    await f.git("merge-base", "--is-ancestor", f.headCommit, "HEAD");
    await f.git("merge-base", "--is-ancestor", newHead, "HEAD");
    const hostHead = await f.git("rev-parse", "HEAD");
    const guestIndex = await f.guestGit("write-tree");
    expect(await f.invoke({ conflictsResolved: true, expectedHeadCommit: newHead })).toMatchObject({
      status: "prepared",
      headCommit: newHead,
      changedPaths: [],
    });
    expect(await f.git("rev-parse", "HEAD")).toBe(hostHead);
    expect(await f.guestGit("write-tree")).toBe(guestIndex);
    expect(await f.guestGit("rev-parse", "HEAD")).toBe(guestHead);
    expect(f.writes).toEqual([]);
  });

  it("finishes a merged refresh after its review base failed to prepare", async () => {
    const f = await fixture();
    await f.invoke();
    const acceptedHead = await f.advanceHead({ "pr.txt": "advanced PR\n" });
    const backend = f.sandbox.backend!;
    const run = backend.runShellCommand.bind(backend);
    let failed = false;
    vi.spyOn(backend, "runShellCommand").mockImplementation(async (params) => {
      if (!failed && params.script.includes("for candidate do")) {
        failed = true;
        return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return await run(params);
    });
    await expect(f.invoke()).rejects.toThrow("review-base preparation failed");
    expect(failed).toBe(true);
    // The host merge completed, so the imported file stays staged at its pre-refresh entry.
    expect(await f.guestGit("status", "--porcelain", "pr.txt")).toBe("AM pr.txt");
    expect(await f.invoke()).toMatchObject({ status: "prepared", headCommit: acceptedHead });
    expect(await f.guestGit("show", ":pr.txt")).toBe("advanced PR");
  });

  it("refuses unrelated remote history without pinning it as a pending refresh", async () => {
    const f = await fixture();
    await f.invoke();
    const before = f.readSession().worktree?.githubPullRequest;
    await f.local!.git("-C", f.upstream, "checkout", "--orphan", "replacement");
    await f.local!.git("-C", f.upstream, "commit", "-m", "Replace remote history");
    f.pr.head.sha = await f.local!.git("-C", f.upstream, "rev-parse", "HEAD");
    f.branch.commit.sha = f.pr.head.sha;
    await f.local!.git("-C", f.upstream, "update-ref", "refs/heads/topic/existing", f.pr.head.sha);
    await expect(f.invoke()).rejects.toThrow("could not be integrated");
    expect(f.readSession().worktree?.githubPullRequest).toEqual(before);
    expect(await f.git("rev-parse", "HEAD")).toBe(f.headCommit);
    await f.local!.git("-C", f.upstream, "update-ref", "refs/heads/topic/existing", f.headCommit);
    const next = await f.advanceHead({ "newer-pr.txt": "restored original history\n" });
    expect(await f.invoke()).toMatchObject({ status: "prepared", headCommit: next });
    await f.git("merge-base", "--is-ancestor", f.headCommit, "HEAD");
    expect(f.writes).toEqual([]);
  });
});

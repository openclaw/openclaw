// Install the shared GitHub fixture before loading the registered action owners.
// oxfmt-ignore
import { bindFixtureRuntime, fixture, mocks } from "./github-pr-workspace-preparation.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isNodeError } from "@openclaw/fs-safe/path";
import { describe, expect, it, vi } from "vitest";
import { ensureEmptyWorktreeSource } from "../agents/worktrees/empty-source.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { linkCanonicalUserProfileEmail } from "../state/user-profile-writes.js";
import {
  commandResult,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import * as workspaceStore from "./worker-environments/local-workspace-store.js";
import { isLocalWorkspaceBaseRefreshRef } from "./worker-environments/workspace-result-inventory.js";

describe("existing PR preparation through the registered agent action", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each([false, true])(
    "installs the exact PR head from a clean newer project base and preserves later work (fork=%s)",
    async (fork) => {
      const f = await fixture({ fork });
      const before = f.readSession();
      const originalHead = await f.git("rev-parse", "HEAD");
      const originalGuestHead = await f.guestGit("rev-parse", "HEAD");
      const guestBranch = await f.guestGit("symbolic-ref", "HEAD");
      expect(originalHead).toBe(f.pr.base.sha);
      expect(await f.git("status", "--porcelain")).toBe("");
      expect(await fs.readFile(path.join(f.projection, "newer-base.txt"), "utf8")).toBe(
        "base advanced after PR\n",
      );
      await expect(f.invoke({}, null)).rejects.toThrow("sandboxed agent");
      await expect(f.invoke({}, { ...f.sandbox, workspaceAccess: "ro" })).rejects.toThrow(
        "read-only",
      );
      expect(f.readSession().worktree?.githubPullRequest).toBeUndefined();
      expect(await f.invoke()).toMatchObject({
        status: "prepared",
        url: f.pr.html_url,
        headCommit: f.headCommit,
        headChanged: false,
        review: { mode: "local", base: f.commonAncestor },
      });
      expect(f.readSession()).toMatchObject({
        sessionId: before.sessionId,
        worktree: {
          ...before.worktree,
          githubPullRequest: {
            url: f.pr.html_url,
            host: "github.com",
            number: 7,
            base: {
              repository: "openclaw/openclaw",
              repositoryId: 10,
              branch: "main",
              commit: f.pr.base.sha,
            },
            head: {
              repository: fork ? "contributor/openclaw" : "openclaw/openclaw",
              repositoryId: fork ? 20 : 10,
              branch: "topic/existing",
              commit: f.headCommit,
            },
            preparedHeadCommit: f.headCommit,
          },
        },
      });
      const prTree = await f.local!.git("-C", f.upstream, "rev-parse", `${f.headCommit}^{tree}`);
      expect(await f.git("rev-parse", "HEAD")).toBe(f.headCommit);
      expect(await f.git("write-tree")).toBe(prTree);
      expect(await f.git("diff", "--name-only", f.headCommit)).toBe("");
      expect(await f.git("status", "--porcelain")).toBe("");
      expect(await f.guestGit("write-tree")).toBe(prTree);
      expect(await f.guestGit("diff", "--name-only")).toBe("");
      for (const directory of [f.cwd, f.projection]) {
        expect(await fs.readFile(path.join(directory, "pr.txt"), "utf8")).toBe(
          "original PR contents\n",
        );
        await expect(fs.stat(path.join(directory, "newer-base.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(await f.git("rev-parse", "ORIG_HEAD")).toBe(originalHead);
      expect(await f.guestGit("rev-parse", "HEAD")).toBe(originalGuestHead);
      expect(await f.guestGit("symbolic-ref", "HEAD")).toBe(guestBranch);
      expect(await f.guestGit("rev-parse", "refs/openclaw/review-base")).toBe(f.commonAncestor);
      expect(
        (await f.guestGit("diff", "--cached", "--name-only", f.commonAncestor)).split("\n"),
      ).toContain("pr.txt");

      // Work produced after this PR is accepted belongs to its continuation.
      await fs.writeFile(path.join(f.projection, "guest-commit.txt"), "unpublished guest commit\n");
      await f.guestGit("add", "guest-commit.txt");
      await f.guestGit("commit", "-m", "Guest work after PR preparation");
      const continuedGuestHead = await f.guestGit("rev-parse", "HEAD");
      await fs.writeFile(path.join(f.projection, "artifact.txt"), "guest saved dirty work\n");
      await fs.writeFile(path.join(f.projection, "untracked.txt"), "guest untracked work\n");
      const association = f.readSession().worktree?.githubPullRequest;
      const workspaceState = async () => ({
        hostHead: await f.git("rev-parse", "HEAD"),
        hostIndex: await f.git("write-tree"),
        hostStatus: await f.git("status", "--porcelain"),
        guestHead: await f.guestGit("rev-parse", "HEAD"),
        guestIndex: await f.guestGit("write-tree"),
        guestStatus: await f.guestGit("status", "--porcelain"),
      });
      const beforeRepeat = await workspaceState();
      await closeOpenClawAgentDatabasesAsync();
      expect(f.readSession().worktree?.githubPullRequest).toEqual(association);
      expect(await f.invoke()).toMatchObject({
        status: "prepared",
        headCommit: f.headCommit,
        headChanged: false,
      });
      for (const [file, contents] of Object.entries({
        "guest-commit.txt": "unpublished guest commit\n",
        "artifact.txt": "guest saved dirty work\n",
        "untracked.txt": "guest untracked work\n",
      })) {
        expect(await fs.readFile(path.join(f.projection, file), "utf8")).toBe(contents);
      }
      expect(await workspaceState()).toEqual(beforeRepeat);
      expect(f.readSession().worktree?.githubPullRequest).toEqual(association);
      expect(await fs.readFile(path.join(f.cwd, "artifact.txt"), "utf8")).toBe("base\n");
      for (const file of ["guest-commit.txt", "untracked.txt"]) {
        await expect(fs.stat(path.join(f.cwd, file))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await f.guestGit("rev-parse", "HEAD")).toBe(continuedGuestHead);
      expect(await f.guestGit("symbolic-ref", "HEAD")).toBe(guestBranch);
      await f.advanceHead({ "newer-pr.txt": "newer remote PR work\n" });
      expect(await f.invoke()).toMatchObject({ status: "prepared", headCommit: f.pr.head.sha });
      const refreshedAssociation = f.readSession().worktree?.githubPullRequest;
      expect(refreshedAssociation?.preparedHeadCommit).toBe(f.pr.head.sha);
      await f.git("merge-base", "--is-ancestor", f.headCommit, "HEAD");
      await f.git("merge-base", "--is-ancestor", f.pr.head.sha, "HEAD");
      expect(await f.guestGit("rev-parse", "HEAD")).toBe(continuedGuestHead);
      expect(await f.guestGit("symbolic-ref", "HEAD")).toBe(guestBranch);
      expect(await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8")).toBe(
        "guest saved dirty work\n",
      );
      expect(await fs.readFile(path.join(f.projection, "untracked.txt"), "utf8")).toBe(
        "guest untracked work\n",
      );
      for (const directory of [f.cwd, f.projection]) {
        expect(await fs.readFile(path.join(directory, "newer-pr.txt"), "utf8")).toBe(
          "newer remote PR work\n",
        );
      }
      // Publication accepts only the head this preparation integrated.
      await f.advanceHead({ "newest-pr.txt": "unaccepted remote PR work\n" });
      await expect(
        f.invoke({ action: "publish", pullRequestUrl: undefined }),
      ).resolves.toMatchObject({
        status: "failed",
        code: "push_rejected",
      });
      await expect(f.invoke({ action: "refresh_base", pullRequestUrl: undefined })).rejects.toThrow(
        "prepare_pr",
      );
      await expect(
        f.invoke({
          action: "request_review",
          pullRequestUrl: undefined,
          requestId: randomUUID(),
          expectedHeadCommit: f.headCommit,
        }),
      ).rejects.toThrow("without a publication requestId");
      f.pr.number = 8;
      f.pr.html_url = "https://github.com/openclaw/openclaw/pull/8";
      await expect(f.invoke()).rejects.toThrow("already continues another PR");
      expect(f.readSession().worktree?.githubPullRequest).toEqual(refreshedAssociation);
      expect(await fs.readFile(path.join(f.projection, "untracked.txt"), "utf8")).toBe(
        "guest untracked work\n",
      );
      expect(f.writes).toEqual([]);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it.each([false, true])(
    "uses the actual empty source only when no earlier work needs preserving (earlier notes=%s)",
    async (earlierNotes) => {
      const f = await fixture({ empty: true, fork: true });
      const before = f.readSession();
      const emptyHead = await f.local!.git("-C", f.emptySource!, "rev-parse", "HEAD");
      const guestHead = await f.guestGit("rev-parse", "HEAD");
      const guestBranch = await f.guestGit("symbolic-ref", "HEAD");
      if (earlierNotes) {
        await fs.writeFile(path.join(f.projection, "notes.txt"), "work before the URL arrived\n");
        await expect(f.invoke()).rejects.toThrow("existing dirty, untracked, or unpublished work");
        expect(f.readSession().worktree).toEqual(before.worktree);
        expect(await f.git("rev-parse", "HEAD")).toBe(emptyHead);
        expect(await fs.readFile(path.join(f.projection, "notes.txt"), "utf8")).toBe(
          "work before the URL arrived\n",
        );
        await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(await f.invoke()).toMatchObject({
          status: "prepared",
          headCommit: f.headCommit,
          review: { mode: "local", base: f.commonAncestor },
        });
        expect(f.readSession()).toMatchObject({
          sessionId: before.sessionId,
          spawnedCwd: before.spawnedCwd,
          sessionRoot: before.sessionRoot,
          worktree: { ...before.worktree, githubPullRequest: { preparedHeadCommit: f.headCommit } },
        });
        expect(await f.git("rev-parse", "HEAD")).toBe(f.headCommit);
        const prTree = await f.local!.git("-C", f.upstream, "rev-parse", `${f.headCommit}^{tree}`);
        expect(await f.git("write-tree")).toBe(prTree);
        expect(await f.git("status", "--porcelain")).toBe("");
        expect(await f.guestGit("write-tree")).toBe(prTree);
        expect(await fs.readFile(path.join(f.projection, "pr.txt"), "utf8")).toBe(
          "original PR contents\n",
        );
      }
      expect(await f.guestGit("rev-parse", "HEAD")).toBe(guestHead);
      expect(await f.guestGit("symbolic-ref", "HEAD")).toBe(guestBranch);
      expect(await f.local!.git("-C", f.emptySource!, "rev-parse", "HEAD")).toBe(emptyHead);
      expect(await f.local!.git("-C", f.emptySource!, "status", "--porcelain")).toBe("");
      expect(
        await ensureEmptyWorktreeSource({
          env: process.env,
          ownerId: f.session.sessionKey,
          commitGuard: () => {},
        }),
      ).toBe(f.emptySource);
      expect(f.writes).toEqual([]);
    },
  );

  it("refuses initial dirty, untracked, and unpublished work before changing files, heads or association", async () => {
    const f = await fixture();
    const before = f.readSession();
    const initialHostHead = await f.git("rev-parse", "HEAD");
    const initialGuestHead = await f.guestGit("rev-parse", "HEAD");
    const originalContents = await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8");
    const contents = (directory: string, file: string) =>
      fs.readFile(path.join(directory, file), "utf8").catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
    for (const condition of [
      "staged-only",
      "dirty",
      "untracked",
      "guest commit",
      "host commit",
    ] as const) {
      if (condition === "staged-only") {
        await fs.writeFile(path.join(f.projection, "artifact.txt"), "private staged edit\n");
        await f.guestGit("add", "artifact.txt");
        await fs.writeFile(path.join(f.projection, "artifact.txt"), originalContents);
      } else if (condition === "dirty") {
        await fs.writeFile(path.join(f.projection, "artifact.txt"), "private unfinished edit\n");
      } else if (condition === "untracked") {
        await fs.writeFile(path.join(f.projection, "notes.txt"), "private notes\n");
      } else if (condition === "guest commit") {
        await fs.writeFile(path.join(f.projection, "notes.txt"), "unpublished guest work\n");
        await f.guestGit("add", "notes.txt");
        await f.guestGit("commit", "-m", "Unpublished guest work");
      } else {
        await fs.writeFile(path.join(f.cwd, "notes.txt"), "unpublished host work\n");
        await f.git("add", "notes.txt");
        await f.git("commit", "-m", "Unpublished host work");
      }
      const snapshot = async () => ({
        hostHead: await f.git("rev-parse", "HEAD"),
        guestHead: await f.guestGit("rev-parse", "HEAD"),
        hostStatus: await f.git("status", "--porcelain"),
        guestStatus: await f.guestGit("status", "--porcelain"),
        hostIndex: await f.git("write-tree"),
        guestIndex: await f.guestGit("write-tree"),
        hostArtifact: await contents(f.cwd, "artifact.txt"),
        guestArtifact: await contents(f.projection, "artifact.txt"),
        hostNotes: await contents(f.cwd, "notes.txt"),
        guestNotes: await contents(f.projection, "notes.txt"),
      });
      const saved = await snapshot();
      await expect(f.invoke(), condition).rejects.toThrow(
        "existing dirty, untracked, or unpublished work",
      );
      expect(f.readSession().worktree, condition).toEqual(before.worktree);
      expect(await snapshot(), condition).toEqual(saved);
      await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      // Restore only this rejected fixture change before exercising the next independent input.
      if (condition === "staged-only") {
        await f.guestGit("restore", "--staged", "artifact.txt");
      } else if (condition === "dirty") {
        await fs.writeFile(path.join(f.projection, "artifact.txt"), originalContents);
      } else if (condition === "untracked") {
        await fs.rm(path.join(f.projection, "notes.txt"));
      } else if (condition === "guest commit") {
        await f.guestGit("reset", "--hard", initialGuestHead);
      }
    }
    expect(await f.guestGit("rev-parse", "HEAD")).toBe(initialGuestHead);
    expect(await f.git("show", `${initialHostHead}:artifact.txt`)).toBe("base");
    expect(f.writes).toEqual([]);
  });

  it("preserves work from an earlier publication rather than treating its receipt as the requested PR", async () => {
    const f = await fixture({ priorPublication: true });
    const before = f.readSession();
    const head = await f.git("rev-parse", "HEAD");
    const tree = await f.git("write-tree");
    expect(await fs.readFile(path.join(f.cwd, "artifact.txt"), "utf8")).toBe("accepted\n");
    await expect(f.invoke()).rejects.toThrow("existing dirty, untracked, or unpublished work");
    expect(f.readSession().worktree).toEqual(before.worktree);
    expect(await f.git("rev-parse", "HEAD")).toBe(head);
    expect(await f.git("write-tree")).toBe(tree);
    expect(await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8")).toBe("accepted\n");
    expect(f.publishedTitles).toEqual(["earlier-pr"]);
    expect(f.writes).toEqual([]);
    expect(f.externalWrites).toEqual([]);
  });

  it.each(["authorized", "wrong author", "role", "linked identity"])(
    "keeps private source transfer bound to the current requester (%s)",
    async (variant) => {
      const f = await fixture({ fork: true });
      f.pr.base.repo.private = true;
      f.pr.head.repo.private = true;
      if (variant === "wrong author") {
        f.pr.user.id = 999;
      }
      const snapshot = async () => ({
        worktree: structuredClone(f.readSession().worktree),
        hostHead: await f.git("rev-parse", "HEAD"),
        guestHead: await f.guestGit("rev-parse", "HEAD"),
        hostIndex: await f.git("write-tree"),
        guestIndex: await f.guestGit("write-tree"),
        hostStatus: await f.git("status", "--porcelain"),
        guestStatus: await f.guestGit("status", "--porcelain"),
      });
      const before = await snapshot();
      const transport = mocks.runCommand.getMockImplementation()!;
      let privateAccessReads = 0;
      let fetched = false;
      let authorityChanged = false;
      mocks.runCommand.mockImplementation(
        async (
          argv: string[],
          options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
        ) => {
          if (argv[0] === "gh" && argv.includes("GET") && argv.at(-1) === "user/101") {
            return commandResult(JSON.stringify({ id: 101, login: "contributor" }));
          }
          if (
            argv[0] === "gh" &&
            argv.includes("GET") &&
            argv.at(-1)?.endsWith("/collaborators/contributor/permission")
          ) {
            privateAccessReads += 1;
            return commandResult(
              JSON.stringify({ permission: "read", user: { id: 101, login: "contributor" } }),
            );
          }
          const result = await transport(argv, options);
          if (argv.includes("fetch") && argv.includes(f.headCommit)) {
            expect(result.code).toBe(0);
            fetched = true;
            if (!authorityChanged && variant === "role") {
              await f.revoke();
              authorityChanged = true;
            } else if (!authorityChanged && variant === "linked identity") {
              await linkCanonicalUserProfileEmail(
                "publication-guest@example.test",
                f.maintainerProfile,
              );
              authorityChanged = true;
            }
          }
          return result;
        },
      );
      if (variant === "authorized") {
        await expect(f.invoke()).resolves.toMatchObject({
          status: "prepared",
          headCommit: f.headCommit,
        });
        expect(await fs.readFile(path.join(f.projection, "pr.txt"), "utf8")).toBe(
          "original PR contents\n",
        );
      } else {
        await expect(f.invoke()).rejects.toThrow(
          variant === "wrong author" ? "could not be verified as yours" : undefined,
        );
        expect(await snapshot()).toEqual(before);
        for (const directory of [f.cwd, f.projection]) {
          await expect(fs.stat(path.join(directory, "pr.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      }
      expect(privateAccessReads).toBeGreaterThan(0);
      expect(fetched).toBe(variant !== "wrong author");
      expect(authorityChanged).toBe(variant === "role" || variant === "linked identity");
      expect(f.writes).toEqual([]);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it("checks current write eligibility before binding or changing the workspace", async () => {
    const f = await fixture({ fork: true });
    const before = f.readSession();
    const head = await f.git("rev-parse", "HEAD");
    f.pr.maintainer_can_modify = false;
    await expect(f.invoke()).rejects.toThrow("no observed write permission");
    f.pr.maintainer_can_modify = true;
    f.branch.protected = true;
    await expect(f.invoke()).rejects.toThrow("head branch is protected");
    f.branch.protected = false;
    f.branch.commit.sha = "f".repeat(40);
    await expect(f.invoke()).rejects.toThrow("head branch changed");
    f.branch.commit.sha = f.headCommit;
    f.pr.head.repo.archived = true;
    await expect(f.invoke()).rejects.toThrow("repository is archived");
    expect(f.readSession().worktree).toEqual(before.worktree);
    expect(await f.git("rev-parse", "HEAD")).toBe(head);
    await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.writes).toEqual([]);
  });

  it.each(["different repository", "pending refresh"])(
    "refuses %s before binding or applying PR files",
    async (reason) => {
      const f = await fixture({ conflict: true });
      if (reason === "different repository") {
        mocks.resolveRepository.mockResolvedValue({
          checkoutRoot: f.cwd,
          repoRoot: f.cwd,
          fingerprint: "fingerprint-1",
          originUrl: "https://github.com/other/project.git",
        });
      } else {
        await fs.writeFile(path.join(f.cwd, "artifact.txt"), "existing workspace work\n");
        await f.git("add", "artifact.txt");
        await f.git("commit", "-m", "Existing workspace work");
        await f.git("fetch", f.upstream, f.headCommit);
        await expect(f.git("merge", "--no-commit", "--no-ff", f.headCommit)).rejects.toThrow();
        expect(await f.git("rev-parse", "MERGE_HEAD")).toBe(f.headCommit);
      }
      const before = f.readSession();
      const files = await fs.readFile(path.join(f.cwd, "artifact.txt"), "utf8");
      const head = await f.git("rev-parse", "HEAD");
      await expect(f.invoke()).rejects.toThrow(
        reason === "different repository" ? "another repository" : "Finish refresh_base",
      );
      expect(f.readSession().worktree).toEqual(before.worktree);
      expect(await f.git("rev-parse", "HEAD")).toBe(head);
      expect(await fs.readFile(path.join(f.cwd, "artifact.txt"), "utf8")).toBe(files);
      await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(f.writes).toEqual([]);
    },
  );

  it.each([false, true])(
    "recovers an interrupted initial exact install (bound runtime=%s)",
    async (boundRuntime) => {
      const f = await fixture();
      const runtime = boundRuntime ? await bindFixtureRuntime(f) : undefined;
      using _ = runtime?.projection;
      const originalHead = await f.git("rev-parse", "HEAD");
      const guestHead = await f.guestGit("rev-parse", "HEAD");
      const guestBranch = await f.guestGit("symbolic-ref", "HEAD");
      const withStore = workspaceStore.withLocalWorkspaceStore;
      let interrupted = false;
      const interruption = vi
        .spyOn(workspaceStore, "withLocalWorkspaceStore")
        .mockImplementation((params, operation) =>
          withStore(params, (store) =>
            operation({
              ...store,
              update: async (row, patch, authority) => {
                const result = await store.update(row, patch, authority);
                if (
                  !interrupted &&
                  patch.pending_target === "projection" &&
                  isLocalWorkspaceBaseRefreshRef(result.pending_ref)
                ) {
                  interrupted = true;
                  throw new Error("interrupted after initial canonical acceptance");
                }
                return result;
              },
            }),
          ),
        );
      try {
        await expect(f.invoke()).rejects.toThrow(
          "Accepted workspace publication is indeterminate and requires recovery",
        );
      } finally {
        interruption.mockRestore();
      }
      expect(interrupted).toBe(true);
      expect(f.readSession().worktree?.githubPullRequest).toMatchObject({
        head: { commit: f.headCommit },
      });
      expect(f.readSession().worktree?.githubPullRequest?.preparedHeadCommit).toBeUndefined();
      expect(await f.git("rev-parse", "HEAD")).toBe(originalHead);
      expect(await f.git("rev-parse", "ORIG_HEAD")).toBe(originalHead);
      expect(await f.git("show", "ORIG_HEAD:newer-base.txt")).toBe("base advanced after PR");
      if (boundRuntime) {
        expect(runtime?.isPaused()).toBe(true);
      }
      await f.advanceHead({ "newer-pr.txt": "remote advanced during first import\n" });
      if (!boundRuntime) {
        await closeOpenClawAgentDatabasesAsync();
      }
      expect(await f.invoke()).toMatchObject({
        status: "prepared",
        headCommit: f.headCommit,
        headChanged: true,
      });
      expect(runtime?.isPaused() ?? false).toBe(false);
      expect(await f.git("rev-parse", "HEAD")).toBe(f.headCommit);
      expect(await f.git("diff", "--name-only", f.headCommit)).toBe("");
      expect(await f.guestGit("rev-parse", "HEAD")).toBe(guestHead);
      expect(await f.guestGit("symbolic-ref", "HEAD")).toBe(guestBranch);
      expect(await fs.readFile(path.join(f.projection, "pr.txt"), "utf8")).toBe(
        "original PR contents\n",
      );
      await expect(fs.stat(path.join(f.projection, "newer-base.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(path.join(f.projection, "newer-pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(f.readSession().worktree?.githubPullRequest?.preparedHeadCommit).toBe(f.headCommit);
      expect(f.writes).toEqual([]);
    },
  );
});

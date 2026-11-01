// Install the shared GitHub fixture before loading the registered action owners.
// oxfmt-ignore
import { interruptCanonicalWorkspaceAcceptance, bindFixtureRuntime, fixture, mocks } from "./github-pr-workspace-preparation.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isNodeError } from "@openclaw/fs-safe/path";
import { describe, expect, it, vi } from "vitest";
import * as sandboxBackend from "../agents/sandbox/backend.js";
import { resolveSandboxContext } from "../agents/sandbox/context.js";
import { acquireSandboxGatewayOwner } from "../agents/sandbox/registry.test-support.js";
import { ensureEmptyWorktreeSource } from "../agents/worktrees/empty-source.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  linkCanonicalUserProfileEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import {
  commandResult,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";

describe("existing PR preparation through the registered agent action", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each([false, true])(
    "lets the current maintainer prepare a guest's PR without transferring authority (private=%s)",
    async (privateRepository) => {
      const f = await fixture({ fork: true });
      f.pr.base.repo.private = privateRepository;
      f.pr.head.repo.private = privateRepository;
      const before = f.readSession();
      await expect(
        f.invoke({}, f.sandbox, undefined, { requester: "maintainer" }),
      ).resolves.toMatchObject({ status: "prepared", headCommit: f.headCommit });
      expect(f.readSession().createdActor).toEqual(before.createdActor);
      expect(f.readSession().owner).toEqual(before.owner);
      expect(f.readSession().worktree?.githubPullRequest?.origin).toBe("external-pr");
      expect(await fs.readFile(path.join(f.projection, "pr.txt"), "utf8")).toBe(
        "original PR contents\n",
      );
      await expect(
        f.invoke({ action: "refresh_base", pullRequestUrl: undefined }, f.sandbox, undefined, {
          requester: "maintainer",
        }),
      ).resolves.toMatchObject({ status: "refreshed", baseCommit: f.pr.base.sha });
      expect(await fs.readFile(path.join(f.projection, "newer-base.txt"), "utf8")).toBe(
        "base advanced after PR\n",
      );
      await expect(f.invoke()).resolves.toMatchObject({
        status: "prepared",
        headCommit: f.headCommit,
        review: { base: f.pr.base.sha },
      });
      await expect(
        f.invoke({
          action: "merge",
          pullRequestUrl: undefined,
          expectedHeadCommit: f.headCommit,
          mergeMethod: "squash",
        }),
      ).rejects.toThrow("missing scope: operator.write");
      f.pr.user.id = 999;
      await expect(f.invoke()).rejects.toThrow(
        privateRepository
          ? "could not be verified as yours"
          : "not authored by a GitHub account linked to you",
      );
      expect(f.writes).toEqual([]);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it("records a maintainer's foreign publisher-authored PR as imported", async () => {
    const f = await fixture({ linked: false });
    f.pr.user = { id: 42, login: "roboclaw-bot" };
    await expect(
      f.invoke({}, f.sandbox, undefined, { requester: "maintainer" }),
    ).resolves.toMatchObject({ status: "prepared", headCommit: f.headCommit });
    expect(f.readSession().worktree?.githubPullRequest?.origin).toBe("external-pr");
    await expect(f.invoke()).rejects.toThrow("Link a verified");
    expect(f.writes).toEqual([]);
    expect(f.externalWrites).toEqual([]);
  });

  it.each(["private PR", "revoked transfer", "revoked recovery"] as const)(
    "preserves the bound workspace when base refresh is unauthorized (%s)",
    async (condition) => {
      const privatePr = condition === "private PR";
      const f = await fixture({ fork: true, linked: !privatePr, conflict: true });
      f.pr.base.repo.private = f.pr.head.repo.private = privatePr;
      expect(
        await f.invoke({}, f.sandbox, undefined, privatePr ? { requester: "maintainer" } : {}),
      ).toMatchObject({ status: "prepared" });
      const upstreamGit = (...args: string[]) => f.local!.git("-C", f.upstream, ...args);
      await upstreamGit("checkout", "main");
      await fs.writeFile(path.join(f.upstream, "artifact.txt"), "new target change\n");
      await upstreamGit("add", "artifact.txt");
      await upstreamGit("commit", "-m", "Advance the target after preparation");
      const baseCommit = (f.pr.base.sha = await upstreamGit("rev-parse", "HEAD"));
      const refresh = (resolved = false) =>
        f.invoke({
          action: "refresh_base",
          pullRequestUrl: undefined,
          ...(resolved ? { conflictsResolved: true, baseCommit } : {}),
        });
      if (condition === "revoked recovery") {
        expect(await refresh()).toMatchObject({ status: "conflicts", baseCommit });
        await fs.writeFile(path.join(f.projection, "artifact.txt"), "resolved guest work\n");
      }
      const snapshot = async () => ({
        binding: f.readSession().worktree,
        hostHead: await f.git("rev-parse", "HEAD"),
        hostIndex: await f.git("write-tree"),
        guestHead: await f.guestGit("rev-parse", "HEAD"),
        guestIndex: await f.guestGit("write-tree"),
        hostFiles: await fs.readFile(path.join(f.cwd, "artifact.txt"), "utf8"),
        guestFiles: await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8"),
      });
      const before = await snapshot();
      let revoked = false;
      if (condition === "revoked transfer") {
        const transport = mocks.runCommand.getMockImplementation()!;
        mocks.runCommand.mockImplementation(async (...args) => {
          const result = await transport(...args);
          if (!revoked && args[0].includes("fetch") && args[0].includes(baseCommit)) {
            await f.revoke();
            revoked = true;
          }
          return result;
        });
      } else if (condition === "revoked recovery") {
        const backend = f.sandbox.backend!;
        const runShell = backend.runShellCommand.bind(backend);
        backend.runShellCommand = async (params) => {
          const result = await runShell(params);
          if (!revoked) {
            await f.revoke();
            revoked = true;
          }
          return result;
        };
      }
      await expect(refresh(condition === "revoked recovery")).rejects.toThrow(
        /verified|permission|revoked|access|changed|unavailable/i,
      );
      expect(revoked).toBe(!privatePr);
      expect(await snapshot()).toEqual(before);
      expect(f.writes).toEqual([]);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it.each(["narrowed", "missing", "revoked"] as const)(
    "refuses a maintainer's %s selected authority before changing the guest workspace",
    async (condition) => {
      const f = await fixture();
      const before = f.readSession();
      const hostHead = await f.git("rev-parse", "HEAD");
      const guestHead = await f.guestGit("rev-parse", "HEAD");
      let revoked = false;
      if (condition === "revoked") {
        const transport = mocks.runCommand.getMockImplementation()!;
        mocks.runCommand.mockImplementation(async (...args) => {
          const result = await transport(...args);
          if (!revoked && args[0].includes("fetch") && args[0].includes(f.headCommit)) {
            await setCanonicalUserProfileRole(f.maintainerProfile, "revoked");
            revoked = true;
          }
          return result;
        });
      }
      await expect(
        f.invoke({}, f.sandbox, undefined, {
          requester: "maintainer",
          caller:
            condition === "missing" ? null : condition === "narrowed" ? "guest" : "maintainer",
        }),
      ).rejects.toThrow(condition === "revoked" ? undefined : "Only the person who started");
      expect(revoked).toBe(condition === "revoked");
      expect(f.readSession().worktree).toEqual(before.worktree);
      expect(await f.git("rev-parse", "HEAD")).toBe(hostHead);
      expect(await f.guestGit("rev-parse", "HEAD")).toBe(guestHead);
      await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(f.writes).toEqual([]);
    },
  );

  it.each([
    { fork: false, baseBranch: "main", projectFork: false },
    { fork: true, baseBranch: "main", projectFork: false },
    { fork: true, baseBranch: "release", projectFork: false },
    { fork: true, baseBranch: "release", projectFork: true },
  ])(
    "installs the exact PR head from a clean newer project base and preserves later work (fork=$fork, base=$baseBranch, projectFork=$projectFork)",
    async ({ fork, baseBranch, projectFork }) => {
      const f = await fixture({ fork, baseBranch, projectFork, newerProjectBase: true });
      const before = f.readSession();
      const originalHead = await f.git("rev-parse", "HEAD");
      const originalGuestHead = await f.guestGit("rev-parse", "HEAD");
      const guestBranch = await f.guestGit("symbolic-ref", "HEAD");
      expect(await f.git("rev-list", "--count", `${f.pr.base.sha}..HEAD`)).toBe("5");
      expect(await f.git("merge-base", originalHead, f.pr.base.sha)).toBe(f.pr.base.sha);
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
              branch: baseBranch,
              commit: f.pr.base.sha,
            },
            head: {
              repository: fork ? "contributor/openclaw" : "openclaw/openclaw",
              repositoryId: fork ? 20 : 10,
              branch: "topic/existing",
              commit: f.headCommit,
            },
            origin: "external-pr",
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
        guestArtifact: await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8"),
        guestUntracked: await fs.readFile(path.join(f.projection, "untracked.txt"), "utf8"),
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
      for (const advance of [false, true]) {
        if (advance) {
          await f.advanceHead({ "newer-pr.txt": "newer remote PR work\n" });
        }
        f.pr.base.ref = "another-base";
        const beforeRetarget = await workspaceState();
        expect(await f.invoke()).toMatchObject({ status: "prepared", headCommit: f.pr.head.sha });
        expect(f.readSession().worktree?.githubPullRequest?.base.branch).toBe("another-base");
        if (!advance) {
          expect(await workspaceState()).toEqual(beforeRetarget);
        }
      }
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
        nextAction: expect.stringContaining("call prepare_pr with this PR's URL"),
      });
      await expect(
        f.invoke({ action: "refresh_base", pullRequestUrl: undefined }),
      ).resolves.toMatchObject({
        status: "refreshed",
        baseCommit: f.pr.base.sha,
      });
      // Updating the base does not accept a different writer's remote PR head.
      await expect(
        f.invoke({ action: "publish", pullRequestUrl: undefined }),
      ).resolves.toMatchObject({
        status: "failed",
        code: "push_rejected",
      });
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

  it("reconciles a new destination and its advancing tip without restaging saved work", async () => {
    const f = await fixture();
    const acceptedHead = await f.advanceHead({ "continued-pr.txt": "later contribution\n" });
    expect(await f.invoke()).toMatchObject({ review: { base: f.commonAncestor } });
    await fs.writeFile(path.join(f.projection, "notes.txt"), "saved guest history\n");
    await f.guestGit("add", "notes.txt");
    await f.guestGit("commit", "-m", "Save guest work");
    await fs.writeFile(path.join(f.projection, "artifact.txt"), "staged version\n");
    await f.guestGit("add", "artifact.txt");
    await fs.writeFile(path.join(f.projection, "artifact.txt"), "working version\n");
    await fs.writeFile(path.join(f.projection, "untracked.txt"), "untracked work\n");
    const snapshot = async () => ({
      hostHead: await f.git("rev-parse", "HEAD"),
      hostIndex: await f.git("write-tree"),
      guestHead: await f.guestGit("rev-parse", "HEAD"),
      guestIndex: await f.guestGit("write-tree"),
      guestStatus: await f.guestGit("status", "--porcelain"),
      artifact: await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8"),
      notes: await fs.readFile(path.join(f.projection, "notes.txt"), "utf8"),
      untracked: await fs.readFile(path.join(f.projection, "untracked.txt"), "utf8"),
    });
    const before = await snapshot();
    f.pr.base.ref = "new-destination";
    f.pr.base.sha = f.headCommit;
    await f.local!.git("-C", f.upstream, "checkout", "-b", f.pr.base.ref, f.headCommit);
    for (const advance of [false, true]) {
      if (advance) {
        await fs.writeFile(path.join(f.upstream, "destination-only.txt"), "new destination work\n");
        await f.local!.git("-C", f.upstream, "add", "destination-only.txt");
        await f.local!.git("-C", f.upstream, "commit", "-m", "Advance destination");
        f.pr.base.sha = await f.local!.git("-C", f.upstream, "rev-parse", "HEAD");
      }
      expect(await f.invoke()).toMatchObject({
        status: "prepared",
        headCommit: acceptedHead,
        headChanged: false,
        changedPaths: [],
        conflictPaths: [],
        review: { mode: "local", base: f.headCommit },
      });
      expect(await f.guestGit("rev-parse", "refs/openclaw/review-base")).toBe(f.headCommit);
      expect(f.readSession().worktree?.githubPullRequest).toMatchObject({
        base: { branch: f.pr.base.ref, commit: f.pr.base.sha },
        head: { commit: acceptedHead },
        preparedHeadCommit: acceptedHead,
      });
      expect(await snapshot()).toEqual(before);
      await expect(fs.stat(path.join(f.projection, "destination-only.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(f.writes).toEqual([]);
  });

  it.each(["clean", "authored directory", "cache-only directory"] as const)(
    "admits only pristine source after native managed sandbox layout (%s)",
    async (contents) => {
      const f = await fixture({ empty: true, fork: true });
      f.config.agents ??= {};
      f.config.agents.defaults ??= {};
      f.config.agents.defaults.sandbox = {
        mode: "all",
        workspaceAccess: "rw",
        prune: { idleHours: 0, maxAgeDays: 0 },
        docker: { user: "1000:1000" },
      };
      using gatewayOwner = acquireSandboxGatewayOwner(process.env.OPENCLAW_STATE_DIR!);
      // Only container transport is synthetic; layout, projection and source import stay real.
      const create = vi
        .spyOn(sandboxBackend, "createSandboxBackend")
        .mockResolvedValue(f.sandbox.backend!);
      let sandbox: Awaited<ReturnType<typeof resolveSandboxContext>> = null;
      try {
        sandbox = await resolveSandboxContext({
          config: f.config,
          agentId: "main",
          sessionKey: f.session.sessionKey,
          workspaceDir: f.cwd,
          assertCurrent: () => {
            gatewayOwner.assertCurrent();
            f.guest.assertCurrent();
          },
        });
        expect(sandbox?.workspaceSource).toBe("managed-worktree");
        if (contents === "authored directory") {
          await fs.mkdir(path.join(f.projection, "saved-empty"));
          await expect(f.invoke({}, sandbox)).rejects.toThrow(
            "existing dirty, untracked, or unpublished work",
          );
          expect((await fs.stat(path.join(f.projection, "saved-empty"))).isDirectory()).toBe(true);
          await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(f.readSession().worktree?.githubPullRequest).toBeUndefined();
        } else {
          if (contents === "cache-only directory") {
            await fs.mkdir(path.join(f.projection, ".cache", "vitest"), { recursive: true });
          }
          expect(await f.invoke({}, sandbox)).toMatchObject({
            status: "prepared",
            headCommit: f.headCommit,
          });
          expect(await fs.readFile(path.join(f.projection, "pr.txt"), "utf8")).toBe(
            "original PR contents\n",
          );
          expect(await f.git("rev-parse", "HEAD")).toBe(f.headCommit);
          await expect(fs.stat(path.join(f.cwd, ".cache"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        expect(f.writes).toEqual([]);
      } finally {
        sandbox?.[Symbol.dispose]?.();
        create.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "prepares cold PR history and current files without historical blobs (empty=%s)",
    async (empty) => {
      const f = await fixture({ empty, fork: true });
      const upstream = (...args: string[]) => f.local!.git("-C", f.upstream, ...args);
      await upstream("config", "uploadpack.allowFilter", "true");
      await f.advanceHead({ "pr.txt": "obsolete PR contents\n" });
      const historicalBlob = await upstream("rev-parse", "HEAD:pr.txt");
      const head = await f.advanceHead({ "pr.txt": "current PR contents\n" });
      // Advance the base after the selected project's local snapshot.
      await upstream("checkout", "main");
      for (const contents of ["obsolete base contents\n", "current base contents\n"]) {
        await fs.writeFile(path.join(f.upstream, "base-only.txt"), contents);
        await upstream("add", "base-only.txt");
        await upstream("commit", "-m", "Advance base");
      }
      const historicalBaseBlob = await upstream("rev-parse", "HEAD^:base-only.txt");
      f.pr.base.sha = await upstream("rev-parse", "HEAD");
      // Git stores filter defaults per URL; a fork must not share its base's URL.
      const baseUrl = `${pathToFileURL(f.upstream).href}/.`;
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(
        (argv: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) =>
          transport(
            argv.map((arg) => (arg === "https://github.com/openclaw/openclaw.git" ? baseUrl : arg)),
            options,
          ),
      );
      vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
      await expect(f.git("cat-file", "-e", head)).rejects.toThrow();
      await expect(f.git("cat-file", "-e", f.pr.base.sha)).rejects.toThrow();

      expect(await f.invoke()).toMatchObject({
        status: "prepared",
        headCommit: head,
        review: { mode: "local", base: f.commonAncestor },
      });
      expect(await f.git("rev-parse", "--is-shallow-repository")).toBe("false");
      expect(await f.git("rev-list", "--count", head)).toBe("4");
      expect(await f.git("write-tree")).toBe(await upstream("rev-parse", `${head}^{tree}`));
      expect(
        await f.git("rev-list", "--objects", "--missing=print", "--max-count=1", head),
      ).not.toContain("?");
      for (const blob of [historicalBlob, historicalBaseBlob]) {
        await expect(f.git("cat-file", "-e", blob)).rejects.toThrow();
      }
      expect(await f.git("show", `${f.pr.base.sha}:base-only.txt`)).toBe("current base contents");
      expect(await fs.readFile(path.join(f.projection, "pr.txt"), "utf8")).toBe(
        "current PR contents\n",
      );

      const fetches = () => mocks.runCommand.mock.calls.filter(([argv]) => argv.includes("fetch"));
      const beforeRepeat = fetches().length;
      expect(await f.invoke()).toMatchObject({ status: "prepared", headCommit: head });
      expect(fetches()).toHaveLength(beforeRepeat);
      expect(f.writes).toEqual([]);
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

  it("preserves a clean initial projection containing unpublished project history", async () => {
    const f = await fixture({
      fork: true,
      projectFork: true,
      baseBranch: "release",
      newerProjectBase: true,
      unpublishedProjectWork: true,
    });
    const before = f.readSession().worktree;
    const head = await f.git("rev-parse", "HEAD");
    const tree = await f.git("write-tree");
    expect(await f.guestGit("rev-parse", "HEAD")).toBe(head);
    expect(await f.git("status", "--porcelain")).toBe("");
    expect(await f.guestGit("status", "--porcelain")).toBe("");
    await expect(f.invoke()).rejects.toThrow("existing dirty, untracked, or unpublished work");
    expect(f.readSession().worktree).toEqual(before);
    for (const git of [f.git, f.guestGit]) {
      expect(await git("rev-parse", "HEAD")).toBe(head);
      expect(await git("write-tree")).toBe(tree);
      expect(await git("status", "--porcelain")).toBe("");
    }
    for (const directory of [f.cwd, f.projection]) {
      expect(await fs.readFile(path.join(directory, "notes.txt"), "utf8")).toBe(
        "unpublished project work\n",
      );
      await expect(fs.stat(path.join(directory, "pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(f.writes).toEqual([]);
    expect(f.externalWrites).toEqual([]);
  });

  it.each([
    ["timeout", "Git commit fetch failed (timed out after 60 seconds; signal SIGTERM)"],
    ["command", "Git commit fetch failed: spawn git ENOENT"],
    [
      "inventory",
      "Git content inventory failed (exit code 128): fatal: unreadable object database",
    ],
    ["content fetch", "Git content fetch failed (exit code 128): fatal: unavailable object"],
    ["incomplete", "Git content verification failed: required objects are still missing"],
  ])("preserves the acquisition failure reason and workspace (%s)", async (failure, expected) => {
    const f = await fixture();
    const state = async () => ({
      hostHead: await f.git("rev-parse", "HEAD"),
      hostIndex: await f.git("write-tree"),
      guestHead: await f.guestGit("rev-parse", "HEAD"),
      guestIndex: await f.guestGit("write-tree"),
    });
    const before = await state();
    const transport = mocks.runCommand.getMockImplementation()!;
    const failed = (stderr: string) => ({
      ...commandResult("private repository output", 128),
      termination: "exit",
      stderr: Buffer.from(stderr),
    });
    mocks.runCommand.mockImplementation(async (argv: string[], options) => {
      if (argv.includes("fetch")) {
        if (failure === "timeout") {
          return { ...failed(""), code: null, termination: "timeout", signal: "SIGTERM" };
        }
        if (failure === "command") {
          return {
            ...failed(""),
            code: null,
            termination: "error",
            error: new Error(
              "spawn git ENOENT https://example.test/git?unknown=fixture-cause-secret",
            ),
          };
        }
        if (argv.includes("--stdin")) {
          return failure === "content fetch"
            ? failed("fatal: unavailable object")
            : commandResult();
        }
      }
      if (argv.includes("--missing=print")) {
        return failure === "inventory"
          ? failed("fatal: unreadable object database")
          : commandResult(`?${"f".repeat(40)}\n`);
      }
      return await transport(argv, options);
    });
    const error = await f.invoke().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(expected);
    expect(String(error)).not.toMatch(
      /private repository output|fixture-cause-secret|example\.test/u,
    );
    expect(await state()).toEqual(before);
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
      const { interruption, wasInterrupted } = interruptCanonicalWorkspaceAcceptance(
        "interrupted after initial canonical acceptance",
      );
      try {
        await expect(f.invoke()).rejects.toThrow(
          "Accepted workspace publication is indeterminate and requires recovery",
        );
      } finally {
        interruption.mockRestore();
      }
      expect(wasInterrupted()).toBe(true);
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

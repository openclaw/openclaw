// Install the shared GitHub fixture before loading the registered action owners.
// oxfmt-ignore
import { bindFixtureRuntime, fixture, mocks } from "./github-pr-workspace-preparation.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { linkCanonicalUserProfileEmail } from "../state/user-profile-writes.js";
import { installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import * as workspaceStore from "./worker-environments/local-workspace-store.js";
import { isLocalWorkspaceBaseRefreshRef } from "./worker-environments/workspace-result-inventory.js";

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
      const withStore = workspaceStore.withLocalWorkspaceStore;
      let interrupted = false;
      const interruption = vi
        .spyOn(workspaceStore, "withLocalWorkspaceStore")
        .mockImplementation((params, operation) =>
          withStore(params, (store) =>
            operation({
              ...store,
              update: async (row, patch, authority, manifest) => {
                const result = await store.update(row, patch, authority, manifest);
                if (
                  !interrupted &&
                  patch.pending_target === "projection" &&
                  isLocalWorkspaceBaseRefreshRef(result.pending_ref)
                ) {
                  interrupted = true;
                  throw new Error("interrupted after canonical acceptance");
                }
                return result;
              },
            }),
          ),
        );
      try {
        await expect(f.invoke()).rejects.toThrow("indeterminate and requires recovery");
      } finally {
        interruption.mockRestore();
      }
      expect(interrupted).toBe(true);
      expect(f.readSession().worktree?.githubPullRequest).toMatchObject({
        url: f.pr.html_url,
        head: { commit: acceptedHead },
        preparedHeadCommit: f.headCommit,
      });
      await f.advanceHead({ "newer-pr.txt": "remote advanced during recovery\n" });
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
      });
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

// Keep GitHub transport synthetic while exercising real Git, session custody and durable receipts.
// oxfmt-ignore
import { publicationCheckpoint as checkpoint } from "./github-publication-actions.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import { syncCanonicalGitHubIdentity } from "../state/user-profile-writes.js";
import {
  createPublicationRepositories,
  createRequesterPublicationFixture,
} from "./github-publication-requester.test-support.js";
import {
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";

const mocks = githubPublicationTestMocks();

async function fixture(fork = false, linked = true, maintainer = false, sameBranch = false) {
  const f = await createRequesterPublicationFixture(checkpoint, "local");
  const local = f.local!;
  if (linked) {
    await syncCanonicalGitHubIdentity({
      identity: { accountId: 101, login: "contributor" },
      authenticationAlias: { kind: "email", email: "publication-guest@example.test" },
    });
  }
  await local.git("reset", "--hard", "HEAD");
  const baseHead = await local.git("rev-parse", "HEAD");
  await fs.writeFile(path.join(local.cwd, "original.txt"), "Original contribution\n");
  await local.git("add", "original.txt");
  await local.git("commit", "-m", "Original contributor work");
  const originalHead = await local.git("rev-parse", "HEAD");
  const { baseRepo, headRepo } = createPublicationRepositories(fork);
  const pr = {
    number: 7,
    html_url: "https://github.com/openclaw/openclaw/pull/7",
    user: { id: 101, login: "contributor" },
    state: "open",
    draft: true,
    merged: false,
    maintainer_can_modify: true,
    base: { repo: baseRepo, ref: "main", sha: baseHead },
    head: { repo: headRepo, ref: "topic/original", sha: originalHead },
  };
  const scope = { agentId: "main", sessionKey: f.session.sessionKey };
  const entry = loadSessionEntryReadOnly(scope)!;
  const publicationSession = { ...scope, sessionId: f.session.sessionId };
  if (sameBranch) {
    pr.head.ref = entry.worktree!.branch;
  }
  const updateBinding = async (binding: SessionGitHubPullRequestBinding) => {
    const current = loadSessionEntryReadOnly(scope)!;
    await upsertSessionEntryCore(scope, {
      ...current,
      worktree: { ...current.worktree!, githubPullRequest: binding },
    });
  };
  await updateBinding({
    url: pr.html_url,
    host: "github.com",
    number: 7,
    base: {
      repository: baseRepo.full_name,
      repositoryId: 10,
      branch: "main",
      commit: baseHead,
    },
    head: {
      repository: headRepo.full_name,
      repositoryId: headRepo.id,
      branch: pr.head.ref,
      commit: originalHead,
    },
    origin: "external-pr",
    preparedHeadCommit: originalHead,
  });
  await fs.writeFile(path.join(local.cwd, "continued.txt"), "Guest continuation\n");
  const transport = mocks.runCommand.getMockImplementation()!;
  const pushes: string[][] = [];
  const mutations: string[][] = [];
  const remoteCommits = new Set([originalHead]);
  let branchHead = originalHead;
  let afterPush: (() => Promise<void>) | undefined;
  let beforeRead: ((endpoint: string) => Promise<void>) | undefined;
  let losePushResponse = false;
  mocks.runCommand.mockImplementation(async (argv: string[], options) => {
    if (argv.includes("push")) {
      pushes.push(argv);
      const refspec = argv.at(-1)!;
      const [commit, ref] = refspec.split(":");
      expect(ref).toBe(`refs/heads/${pr.head.ref}`);
      expect(argv.at(-2)).toBe(`https://github.com/${headRepo.full_name}.git`);
      expect(argv).toContain(`--force-with-lease=refs/heads/${pr.head.ref}:${branchHead}`);
      expect(await local.git("merge-base", branchHead, commit!)).toBe(branchHead);
      branchHead = commit!;
      pr.head.sha = commit!;
      remoteCommits.add(commit!);
      await afterPush?.();
      if (losePushResponse) {
        losePushResponse = false;
        throw new Error("Accepted push response lost");
      }
      return commandResult();
    }
    if (argv.includes("ls-remote")) {
      return commandResult(`${branchHead}\trefs/heads/${pr.head.ref}\n`);
    }
    if (argv[0] === "gh") {
      if (argv.includes("POST") || argv.includes("PATCH") || argv.includes("DELETE")) {
        mutations.push(argv);
        throw new Error("An imported publication must not create or edit a PR");
      }
      const endpoint = argv[argv.indexOf("GET") + 1]!;
      await beforeRead?.(endpoint);
      const value =
        endpoint === `repos/${baseRepo.full_name}`
          ? baseRepo
          : endpoint === `repos/${headRepo.full_name}`
            ? headRepo
            : endpoint === `repos/${baseRepo.full_name}/pulls/7`
              ? argv.includes("--jq")
                ? {
                    url: pr.html_url,
                    userId: pr.user.id,
                    state: pr.state,
                    body: "",
                    headSha: pr.head.sha,
                    headRef: pr.head.ref,
                    baseRef: pr.base.ref,
                    headRepository: headRepo.full_name,
                    headRepositoryId: headRepo.id,
                    baseRepository: baseRepo.full_name,
                    baseRepositoryId: baseRepo.id,
                  }
                : pr
              : endpoint ===
                  `repos/${headRepo.full_name}/branches/${encodeURIComponent(pr.head.ref)}`
                ? { name: pr.head.ref, commit: { sha: branchHead }, protected: false }
                : undefined;
      if (value) {
        return commandResult(JSON.stringify(value));
      }
      const comparePrefix = `repos/${headRepo.full_name}/compare/`;
      if (endpoint.startsWith(comparePrefix)) {
        const [from, to] = endpoint.slice(comparePrefix.length).split("?")[0]!.split("...");
        if (!remoteCommits.has(from!) || !remoteCommits.has(to!)) {
          return commandResult("", 1);
        }
        return commandResult(JSON.stringify({ sha: await local.git("merge-base", from!, to!) }));
      }
      const commitPrefix = `repos/${headRepo.full_name}/git/commits/`;
      if (endpoint.startsWith(commitPrefix)) {
        const sha = endpoint.slice(commitPrefix.length);
        if (!remoteCommits.has(sha)) {
          return commandResult("", 1);
        }
        return commandResult(
          JSON.stringify({
            sha,
            tree: { sha: await local.git("rev-parse", `${sha}^{tree}`) },
            parents: (await local.git("show", "-s", "--format=%P", sha))
              .split(" ")
              .map((parent) => ({ sha: parent })),
            message: await local.git("show", "-s", "--format=%B", sha),
          }),
        );
      }
    }
    return await transport(argv, options);
  });
  return {
    ...f,
    local,
    pr,
    originalHead,
    pushes,
    mutations,
    entry,
    publicationSession,
    publish: (key: string) =>
      f.coordinator.requestForSessionV2(f.request(key, maintainer ? f.maintainer : f.guest)),
    expectWrites(count: number) {
      expect(pushes).toHaveLength(count);
      expect(mutations).toEqual([]);
    },
    expectPublished(result: unknown, headCommit?: string) {
      expect(result).toMatchObject({
        status: "published",
        url: pr.html_url,
        ...(headCommit ? { headCommit } : {}),
      });
    },
    changeBoundHead(commit: string) {
      const binding = loadSessionEntryReadOnly(scope)!.worktree!.githubPullRequest!;
      return updateBinding({ ...binding, head: { ...binding.head, commit } });
    },
    onRead(callback: typeof beforeRead) {
      beforeRead = callback;
    },
    afterPush(callback: typeof afterPush) {
      afterPush = callback;
    },
    loseResponse() {
      losePushResponse = true;
    },
    rewindRemoteBranch() {
      branchHead = originalHead;
    },
    async pushAsAuthor(parent: string) {
      const tree = await local.git("rev-parse", `${parent}^{tree}`);
      branchHead = await local.git("commit-tree", tree, "-p", parent, "-m", "Author follow-up");
      pr.head.sha = branchHead;
      remoteCommits.add(branchHead);
    },
    async acceptNewerSource() {
      await fs.writeFile(
        path.join(local.cwd, "remote-refresh.txt"),
        "Accepted newer remote work\n",
      );
      await local.git("add", "remote-refresh.txt");
      await local.git("commit", "-m", "Newer original PR head");
      branchHead = await local.git("rev-parse", "HEAD");
      pr.head.sha = branchHead;
      remoteCommits.add(branchHead);
      const binding = loadSessionEntryReadOnly(scope)!.worktree!.githubPullRequest!;
      await updateBinding({
        ...binding,
        head: { ...binding.head, commit: branchHead },
        preparedHeadCommit: branchHead,
      });
      return branchHead;
    },
  };
}

describe("shared publication to a prepared original PR", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each([
    { fork: false, maintainer: false },
    { fork: true, maintainer: false },
    { fork: true, maintainer: true },
  ])(
    "appends to the original PR and retains local branch custody across repeat publication (fork=$fork, maintainer=$maintainer)",
    async ({ fork, maintainer }) => {
      const f = await fixture(fork, true, maintainer);
      const result = await f.publish("first-update");
      expect(result).toMatchObject({
        status: "published",
        url: f.pr.html_url,
        branch: "topic/original",
        repository: "openclaw/openclaw",
        headCommit: f.pr.head.sha,
      });
      expect(await f.local.git("merge-base", f.originalHead, f.pr.head.sha)).toBe(f.originalHead);
      expect(await f.local.git("symbolic-ref", "--short", "HEAD")).toBe(f.entry.worktree!.branch);
      expect(f.pr).toMatchObject({ number: 7, user: { id: 101 }, draft: true });
      expect(f.mutations).toEqual([]);
      expect(await f.publish("first-update")).toEqual(result);
      await fs.writeFile(path.join(f.local.cwd, "continued.txt"), "Second continuation\n");
      expect(await f.publish("second-update")).toMatchObject({
        status: "published",
        url: f.pr.html_url,
        branch: "topic/original",
      });
      f.expectWrites(2);
      expect(
        await f.coordinator.latestPublishedShared(f.publicationSession, undefined),
      ).toMatchObject({
        result: { status: "published", headCommit: f.pr.head.sha },
      });
      await f.changeBoundHead("f".repeat(40));
      await expect(f.publish("pending-preparation")).rejects.toThrow("Finish preparing");
      expect(f.pushes).toHaveLength(2);
      expect(
        await f.coordinator.latestPublishedShared(f.publicationSession, undefined),
      ).toMatchObject({
        result: { status: "published", url: f.pr.html_url, headCommit: f.pr.head.sha },
      });
    },
  );

  it.each([
    "unlinked",
    "wrong author",
    "maintainer edits disabled",
    "remote advance",
    "revoked role",
  ])("refuses %s without changing the original branch", async (scenario) => {
    const f = await fixture(true, scenario !== "unlinked");
    if (scenario === "wrong author") {
      f.pr.user.id = 202;
    }
    if (scenario === "maintainer edits disabled") {
      f.pr.maintainer_can_modify = false;
    }
    if (scenario === "remote advance") {
      f.pr.head.sha = "f".repeat(40);
    }
    if (scenario === "revoked role") {
      await f.revoke();
    }
    try {
      const result = await f.publish(scenario);
      expect(result).toMatchObject({ status: "failed" });
      if (scenario === "remote advance") {
        expect(result).toMatchObject({
          code: "push_rejected",
          nextAction: expect.stringContaining("Do not create a replacement PR"),
        });
      }
    } catch (error) {
      expect(String(error)).toMatch(/authoriz|authority|scope/);
    }
    f.expectWrites(0);
    expect(await f.local.git("rev-parse", "HEAD")).toBe(f.originalHead);
  });

  it.each([false, true])(
    "does not grant guest authorship from a maintainer's imported-PR update receipt (same branch=%s)",
    async (sameBranch) => {
      const f = await fixture(false, false, true, sameBranch);
      f.pr.user = { id: 42, login: "roboclaw-bot" };
      const { inspectOwnGitHubPullRequest } = await import("./github-publication-inspect.js");
      await expect(
        inspectOwnGitHubPullRequest({
          pullRequestUrl: f.pr.html_url,
          session: f.publicationSession,
          requester: f.guest,
          assertCurrent: () => f.guest.assertCurrent(),
        }),
      ).rejects.toThrow("Link a verified");
      f.expectPublished(await f.publish("maintainer-assistance"));
      expect(
        await f.coordinator.latestPublishedShared(f.publicationSession, undefined),
      ).toMatchObject({
        result: { status: "published", url: f.pr.html_url },
      });
      await fs.writeFile(path.join(f.local.cwd, "after-assistance.txt"), "guest change");
      const result = await f
        .restart()
        .requestForSessionV2(f.request("guest-after-assistance", f.guest));
      expect(result.status).toBe("failed");
      f.expectWrites(1);
    },
  );

  it("publishes a full revert to the original PR and reuses its unchanged head", async () => {
    const f = await fixture(true);
    const baseTree = await f.local.git("rev-parse", `${f.pr.base.sha}^{tree}`);
    await fs.rm(path.join(f.local.cwd, "original.txt"));
    await fs.rm(path.join(f.local.cwd, "continued.txt"));
    const result = await f.publish("full-revert");
    expect(result).toMatchObject({
      status: "published",
      url: f.pr.html_url,
      branch: "topic/original",
    });
    const revertedHead = f.pr.head.sha;
    expect(await f.local.git("rev-parse", `${revertedHead}^`)).toBe(f.originalHead);
    expect(await f.local.git("rev-parse", `${revertedHead}^{tree}`)).toBe(baseTree);
    expect(await f.publish("full-revert")).toEqual(result);
    expect(await f.publish("unchanged-full-revert")).toMatchObject({
      status: "published",
      url: f.pr.html_url,
      headCommit: revertedHead,
    });
    expect(await f.local.git("rev-parse", "HEAD")).toBe(revertedHead);
    f.expectWrites(1);
  });

  it("settles an accepted original-PR push after requester revocation without another write", async () => {
    const f = await fixture(true);
    f.afterPush(() => f.revoke());
    f.expectPublished(await f.publish("revoked-after-push"), f.pr.head.sha);
    f.expectWrites(1);
  });

  it.each(["push response", "PR observation"])(
    "retains the accepted receipt after losing %s and recovers without a new request",
    async (failure) => {
      const f = await fixture(true);
      const claim =
        failure === "PR observation"
          ? await f.placements.claimTurn({
              sessionId: f.session.sessionId,
              sessionKey: f.session.sessionKey,
              agentId: "main",
              claimId: "original-pr-claim",
              runId: "original-pr-run",
              owner: { kind: "local" },
            })
          : undefined;
      if (failure === "push response") {
        f.loseResponse();
      } else {
        f.onRead(async (endpoint) => {
          if (f.pushes.length > 0 && endpoint.endsWith("/pulls/7")) {
            f.onRead(undefined);
            throw new Error("PR observation unavailable after the accepted push");
          }
        });
      }
      f.afterPush(async () => {
        f.pr.maintainer_can_modify = false;
      });
      const pending = await f.coordinator.requestForSessionV2({
        ...f.request("lost-response", f.guest),
        ...(claim ? { expectedRunId: claim.runId } : {}),
      });
      expect(pending).toMatchObject({
        status: "publishing",
        requestId: expect.any(String),
        message: expect.stringContaining("Finish the turn"),
      });
      expect(f.pushes).toHaveLength(1);
      const session = f.publicationSession;
      expect(await f.coordinator.latestShared(session, "lost-response")).toMatchObject({
        result: { requestId: pending.requestId, status: "publishing" },
      });
      if (claim) {
        await f.placements.releaseTurn(claim);
        await f.coordinator.deferOrphanedRequestsAsync();
      }
      await f.coordinator.resumeSessionRequests();
      expect(await f.coordinator.sharedStatus(session, pending.requestId)).toMatchObject({
        result: {
          requestId: pending.requestId,
          status: "published",
          url: f.pr.html_url,
          headCommit: f.pr.head.sha,
        },
      });
      f.expectWrites(1);
    },
  );
  it("reconciles an accepted update without repushing after a remote branch rewind", async () => {
    const f = await fixture(true);
    f.loseResponse();
    expect(await f.publish("rewound-after-acceptance")).toMatchObject({
      status: "publishing",
    });
    f.rewindRemoteBranch();
    f.pr.maintainer_can_modify = false;
    f.expectPublished(await f.publish("rewound-after-acceptance"), f.pr.head.sha);
    f.expectWrites(1);
  });

  it.each([true, false])(
    "settles an accepted update after a later author push only when it contains that update (descendant=%s)",
    async (descendant) => {
      const f = await fixture(true);
      f.loseResponse();
      expect(await f.publish("author-push-after-acceptance")).toMatchObject({
        status: "publishing",
      });
      const accepted = f.pr.head.sha;
      await f.pushAsAuthor(descendant ? accepted : f.originalHead);
      expect(await f.publish("author-push-after-acceptance")).toMatchObject(
        descendant
          ? { status: "published", url: f.pr.html_url, headCommit: accepted }
          : { status: "failed", code: "push_rejected" },
      );
      f.expectWrites(1);
    },
  );

  it.each(["closed", "revoked"])(
    "preserves an accepted request without returning a receipt to a %s requester",
    async (change) => {
      const f = await fixture(true);
      f.loseResponse();
      f.afterPush(async () => {
        if (change === "closed") {
          f.guestSource.release();
        } else {
          await f.revoke();
        }
      });
      await expect(f.publish("unavailable-after-push")).rejects.toThrow(/authoriz|authority/);
      f.expectWrites(1);
    },
  );

  it("publishes accepted newer source instead of selecting an older publication receipt", async () => {
    const f = await fixture(true);
    expect(await f.publish("before-refresh")).toMatchObject({ status: "published" });
    // The preparation owner is qualified separately; this consumer receives its completed binding.
    const accepted = await f.acceptNewerSource();
    await fs.writeFile(path.join(f.local.cwd, "continued.txt"), "Work after accepted refresh\n");
    f.expectPublished(await f.publish("after-refresh"));
    expect(await f.local.git("merge-base", accepted, f.pr.head.sha)).toBe(accepted);
    f.expectWrites(2);
  });
});

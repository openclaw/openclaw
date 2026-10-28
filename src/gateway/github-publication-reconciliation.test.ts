// Install shared transport mocks before publication owners enter the module cache.
// oxfmt-ignore
import {
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
  root,
} from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as sqliteQueries from "../infra/kysely-sync.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { createRealPublicationWorkspace } from "./github-publication-git.test-support.js";
import {
  createRequesterPolicyFixture,
  capturePublicationGuest,
  createRequesterPublicationFixture,
  holdWorkerTurn,
} from "./github-publication-requester.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

const fixture = createRequesterPublicationFixture.bind(undefined, checkpoint);
type Backend = Parameters<typeof fixture>[0];
const isPullCreation = (argv: string[]) =>
  argv.includes("POST") && argv.some((arg) => arg.endsWith("/pulls"));
const published = (url: string, headCommit: string) => ({ status: "published", url, headCommit });

async function prepareExistingPullRequest(backend: Backend) {
  const f = await fixture(backend);
  const first = await f.coordinator.requestForSessionV2(f.request("first-publication", f.guest));
  if (first.status !== "published") {
    throw new Error("The original fixture publication did not complete.");
  }
  const created = mocks.runCommand.mock.calls.findLast(([argv]) => isPullCreation(argv));
  const receipt = f.readReceipt(first.requestId)!;
  const pullRequest = f.repository?.runtime.pr ?? {
    url: first.url,
    userId: receipt.identity_account_id,
    state: "open",
    body: JSON.parse(created![1].input).body,
    headSha: first.headCommit,
    headRef: receipt.branch,
    baseRef: receipt.base_branch!,
  };
  expect(pullRequest.body).toContain(`<!-- openclaw-publication:${first.requestId} -->`);
  if (f.local) {
    await fs.writeFile(path.join(f.local.cwd, "artifact.txt"), "accepted second publication\n");
  } else {
    await f.repository!.capture("accepted second publication\n", "second-publication");
  }
  return {
    f,
    first,
    pullRequest,
    transport: mocks.runCommand.getMockImplementation()!,
    observePush: async () => {
      pullRequest.headSha = f.local
        ? await f.local.git("rev-parse", "HEAD")
        : f.repository!.runtime.head!;
      expect(pullRequest.headSha).not.toBe(first.headCommit);
    },
  };
}

installGitHubPublicationTestHarness({
  creatorEmail: "publication-guest@example.test",
  sandbox: "required",
  realWorktree: true,
});

it("recovers independent worktrees while preserving each worktree's publication order", async ({
  signal,
}) => {
  vi.stubEnv("GIT_AUTHOR_DATE", "2026-10-27T00:00:00Z");
  vi.stubEnv("GIT_COMMITTER_DATE", "2026-10-27T00:00:00Z");
  const first = await fixture("local");
  const firstWorktree = mocks.findWorktree("session", first.session.sessionKey);
  const firstTransport = mocks.runCommand.getMockImplementation()!;
  const secondSession = {
    sessionId: "session-publication",
    sessionKey: "agent:main:dashboard:independent-publication",
  };
  await persistPublicationTestSession(secondSession.sessionKey);
  const secondRoot = path.join(root, "independent");
  await fs.mkdir(secondRoot);
  mocks.findWorktree.mockReturnValue({
    ...firstWorktree,
    id: "independent-worktree",
    ownerId: secondSession.sessionKey,
    branch: "openclaw/independent-publication",
    repoFingerprint: "independent-fingerprint",
  });
  await createRealPublicationWorkspace({
    root: secondRoot,
    branch: "openclaw/independent-publication",
    sessionKey: secondSession.sessionKey,
    realWorktree: true,
    mocks,
    commandResult,
  });
  const secondWorktree = mocks.findWorktree("session", secondSession.sessionKey);
  const { id: secondWorktreeId, branch, repoRoot } = secondWorktree;
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: secondSession.sessionKey },
    { worktree: { id: secondWorktreeId, branch, repoRoot } },
  );
  const secondTransport = mocks.runCommand.getMockImplementation()!;
  const second = await createRequesterPolicyFixture(secondSession);
  mocks.findWorktree.mockImplementation((_kind, ownerId) =>
    ownerId === first.session.sessionKey ? firstWorktree : secondWorktree,
  );
  mocks.findWorktreeById.mockImplementation((id) =>
    id === firstWorktree.id ? firstWorktree : secondWorktree,
  );
  mocks.resolveRepository.mockImplementation(async (cwd) => {
    const worktree = cwd === first.local!.cwd ? firstWorktree : secondWorktree;
    return {
      checkoutRoot: cwd,
      repoRoot: cwd,
      fingerprint: worktree.repoFingerprint,
      originUrl: "git@github.com:openclaw/openclaw.git",
    };
  });
  const firstDispatched = Promise.withResolvers<void>();
  const independentDispatched = Promise.withResolvers<void>();
  const firstResponse = Promise.withResolvers<void>();
  const titles: string[] = [];
  mocks.runCommand.mockImplementation(
    async (argv: string[], options?: { cwd?: string; input?: string }) => {
      if (isPullCreation(argv)) {
        const title = JSON.parse(options!.input!).title as string;
        titles.push(title);
        if (title === "first") {
          firstDispatched.resolve();
          await firstResponse.promise;
        } else if (title === "independent") {
          independentDispatched.resolve();
        }
      }
      return await (options?.cwd === first.local!.cwd ? firstTransport : secondTransport)(
        argv,
        options,
      );
    },
  );
  for (const session of [first.session, secondSession]) {
    await first.placements.startDispatch({
      ...session,
      agentId: "main",
      executionMode: "worker-turn",
    });
  }
  const firstGuest = await capturePublicationGuest(first);
  const secondGuest = await capturePublicationGuest(second);
  const requests = [
    await first.coordinator.requestForSessionV2(first.request("first", firstGuest.requester)),
    await first.coordinator.requestForSessionV2(first.request("next", firstGuest.requester)),
    await first.coordinator.requestForSessionV2({
      ...first.request("independent", secondGuest.requester),
      sessionKey: secondSession.sessionKey,
    }),
  ];
  expect(requests.map(({ status }) => status)).toEqual(["requested", "requested", "requested"]);
  const recovery = first.coordinator.resumeSessionRequests();
  try {
    await withinTest(Promise.race([firstDispatched.promise, recovery]), signal);
    await withinTest(Promise.race([independentDispatched.promise, recovery]), signal);
    expect(titles).toContain("independent");
    expect(titles).not.toContain("next");
  } finally {
    firstResponse.resolve();
    await recovery;
  }
  for (const { requestId } of requests) {
    expect(first.readReceipt(requestId)?.status).toBe("published");
  }
  const calls = mocks.runCommand.mock.calls.length;
  await first.restart().resumeSessionRequests();
  expect(mocks.runCommand.mock.calls.slice(calls).filter(([argv]) => argv[0] === "gh")).toEqual([]);
});

it.each(["local", "repository"] as const)(
  "settles the accepted %s publication before stopping recovery between requests",
  async (backend) => {
    const f = await fixture(backend);
    const claim = await holdWorkerTurn(f);
    const requests = [
      await f.coordinator.requestForSessionV2(f.request("shutdown-first", f.guest)),
      await f.coordinator.requestForSessionV2(f.request("shutdown-second", f.guest)),
    ];
    expect(requests.map((request) => request.status)).toEqual(["requested", "requested"]);
    await f.placements.releaseTurn(claim);

    const dispatched = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    const transport = mocks.runCommand.getMockImplementation()!;
    let stopping = false;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const result = await transport(argv, options);
      if (isPullCreation(argv)) {
        dispatched.resolve();
        await response.promise;
      }
      return result;
    });

    const recovery = f.coordinator.resumeSessionRequests(() => stopping);
    await dispatched.promise;
    stopping = true;
    response.resolve();
    await recovery;

    expect(f.publishedTitles).toHaveLength(1);
    expect(
      requests
        .map((request) => f.readReceipt(request.requestId)?.status)
        .toSorted((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(["published", "requested"]);
  },
);

it.each([
  { backend: "local", mode: "paged" },
  { backend: "local", mode: "interrupted" },
  { backend: "local", mode: "interrupted-authorized" },
  { backend: "local", mode: "interrupted-authorized-edits" },
  { backend: "local", mode: "interrupted-authorized-deleted" },
  { backend: "local", mode: "interrupted-authorized-merged" },
  { backend: "repository", mode: "paged" },
  { backend: "repository", mode: "interrupted" },
  { backend: "repository", mode: "interrupted-authorized" },
] as const)(
  "reconciles a $mode $backend update when recovering its accepted publication",
  async ({ backend, mode }) => {
    const { f, first, pullRequest, transport, observePush } =
      await prepareExistingPullRequest(backend);
    const closed = Array.from({ length: 30 }, (_, index) => ({
      ...pullRequest,
      url: pullRequest.url.replace(/\d+$/u, String(100 + index)),
      state: "closed",
      body: `<!-- openclaw-publication:earlier-closed-${index} -->`,
    }));
    let branchDeleted = false;
    let acceptedMergeCommit: string | undefined;
    let pushed = false,
      readbackAvailable = false,
      recoveryLookup = false,
      unavailableLookups = 0;
    let acceptedWrites: string[] = [];
    const hostScans = vi.spyOn(sqliteQueries, "iterateSqliteQuerySync");
    let recoveryScanStart = 0;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (branchDeleted && argv.includes("ls-remote")) {
        return commandResult("");
      }
      if (
        acceptedMergeCommit &&
        readbackAvailable &&
        argv.includes("repos/openclaw/openclaw/git/ref/heads/main")
      ) {
        return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: acceptedMergeCommit }));
      }
      if (argv.includes("state=all")) {
        recoveryLookup ||= pushed;
        if (mode === "paged") {
          // gh emits one array per page; the matching open PR is beyond page one.
          return commandResult(
            [closed, ...(argv.includes("--paginate") ? [[pullRequest]] : [])]
              .map((page) => JSON.stringify(page))
              .join("\n"),
          );
        }
        if (pushed && !readbackAvailable) {
          unavailableLookups++;
          return commandResult("", 1);
        }
        return commandResult(JSON.stringify([pullRequest]));
      }
      const response = await transport(argv, options);
      if (argv.includes("push") || argv.includes("graphql")) {
        if (pullRequest.state === "open") {
          await observePush();
        }
        if (mode === "paged") {
          await f.revoke();
        }
        pushed = true;
        branchDeleted = false;
        recoveryScanStart = hostScans.mock.calls.length;
        if (!readbackAvailable) {
          acceptedWrites = [...f.externalWrites];
        }
      }
      return isPullCreation(argv) && readbackAvailable
        ? commandResult(JSON.stringify({ html_url: first.url.replace(/\d+$/u, "125201") }))
        : response;
    });
    const idempotencyKey = `${mode}-update`;
    const publication = f.coordinator.requestForSessionV2(f.request(idempotencyKey, f.guest));
    let requestId: string;
    if (mode === "paged") {
      const result = await publication;
      expect(result).toMatchObject(published(first.url, pullRequest.headSha));
      expect(result.requestId).not.toBe(first.requestId);
      requestId = result.requestId;
      expect({ pushed, recoveryLookup }).toEqual({ pushed: true, recoveryLookup: true });
      expect(
        hostScans.mock.calls
          .slice(recoveryScanStart)
          .map(([, query]) => query.compile().sql)
          .filter((sql) => /from "github_(?:repository_)?publication_requests"/u.test(sql)),
      ).toEqual([]);
      expect(f.readReceipt(requestId)).toMatchObject({
        status: "published",
        pull_request_url: first.url,
        head_commit: pullRequest.headSha,
      });
      expect(f.externalWrites).toEqual(acceptedWrites);
      expect(f.publishedTitles).toEqual(["first-publication"]);
      await f.restart().resumeSessionRequests();
    } else {
      if (backend === "local") {
        await expect(publication).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
        requestId = readGitHubPublicationRequest(f.database.db, {
          sessionId: f.session.sessionId,
          idempotencyKey,
        })!.request_id;
      } else {
        const result = await publication;
        expect(result.status).toBe("requested");
        requestId = result.requestId;
      }
      expect(pushed).toBe(true);
      expect(unavailableLookups).toBeGreaterThan(0);
      expect(f.readReceipt(requestId)).toMatchObject({
        pull_request_url: null,
        head_commit: pullRequest.headSha,
      });
      expect(pullRequest.body).not.toContain(`<!-- openclaw-publication:${requestId} -->`);
      expect(await f.coordinator.readAsync(first.requestId)).toEqual(first);
      acceptedWrites = [...f.externalWrites];
      // Closing the known PR cannot undo an accepted update.
      pullRequest.state = "closed";
      if (mode.startsWith("interrupted-authorized")) {
        if (!f.local) {
          readbackAvailable = true;
          const restarted = f.restart();
          await restarted.resumeSessionRequests();
          expect(f.externalWrites).toEqual(acceptedWrites);
          expect(await restarted.readAsync(requestId)).toMatchObject(
            published(first.url, pullRequest.headSha),
          );
          expect(await restarted.readAsync(first.requestId)).toEqual(first);
          return;
        }
        const { cwd, git } = f.local;
        const acceptedHead = pullRequest.headSha;
        branchDeleted = mode === "interrupted-authorized-deleted";
        if (mode === "interrupted-authorized-merged") {
          acceptedMergeCommit = await git(
            "commit-tree",
            await git("rev-parse", `${pullRequest.headSha}^{tree}`),
            "-p",
            await git("rev-parse", "main"),
            "-p",
            pullRequest.headSha,
            "-m",
            "Accepted PR merge",
          );
        }
        const laterEdits = mode === "interrupted-authorized-edits";
        if (laterEdits) {
          await fs.writeFile(path.join(cwd, "artifact.txt"), "committed later work\n");
          await git("add", "artifact.txt");
          await git("commit", "-m", "Later saved work");
          await fs.writeFile(path.join(cwd, "artifact.txt"), "staged later work\n");
          await git("add", "artifact.txt");
          await fs.writeFile(path.join(cwd, "artifact.txt"), "saved later work\n");
        }
        await fs.writeFile(path.join(cwd, "untracked.txt"), "saved untracked work\n");
        const snapshot = () =>
          Promise.all([
            git("rev-parse", "HEAD"),
            fs.readFile(path.join(cwd, ".git", "index")),
            fs.readFile(path.join(cwd, "artifact.txt")),
            fs.readFile(path.join(cwd, "untracked.txt")),
          ]);
        const saved = await snapshot();
        readbackAvailable = true;
        const restarted = f.restart();
        await restarted.resumeSessionRequests();
        expect(f.externalWrites).toEqual(acceptedWrites);
        expect(await restarted.readAsync(requestId)).toMatchObject(
          published(first.url, pullRequest.headSha),
        );
        expect(await snapshot()).toEqual(saved);
        expect(await restarted.readAsync(first.requestId)).toEqual(first);
        const next = await restarted.requestForSessionV2(f.request("explicit-new-pr", f.guest));
        expect(next).toMatchObject(
          published(first.url.replace(/\d+$/u, "125201"), await git("rev-parse", "HEAD")),
        );
        expect(next.requestId).not.toBe(requestId);
        expect(f.publishedTitles).toEqual(["first-publication", "explicit-new-pr"]);
        expect(await git("show", "HEAD:artifact.txt")).toBe(
          laterEdits ? "saved later work" : "accepted second publication",
        );
        expect(await git("merge-base", saved[0], "HEAD")).toBe(saved[0]);
        expect(pullRequest).toMatchObject({ state: "closed", headSha: acceptedHead });
        return;
      }
      await f.revoke();
      expect(f.guest.assertCurrent).toThrow();
      readbackAvailable = true;
      const restarted = f.restart();
      const read = stateReads.executeExistingOpenClawStateRead;
      const unavailableRead = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation((options, command, readOptions) =>
          command.type === "githubPublication.knownPullRequestUrls" ||
          command.type === "githubRepository.knownPullRequestUrls"
            ? Promise.reject(new Error("receipt worker unavailable"))
            : read(options, command, readOptions),
        );
      const pendingReceipt = f.readReceipt(requestId)!;
      try {
        await expect(restarted.resumeSessionRequests()).rejects.toThrow("unconfirmed");
        expect(f.readReceipt(requestId)).toMatchObject({
          status: expect.stringMatching(/^(requested|publishing)$/u),
          request_digest: pendingReceipt.request_digest,
          head_commit: pendingReceipt.head_commit,
          pull_request_url: null,
        });
        expect(f.externalWrites).toEqual(acceptedWrites);
      } finally {
        unavailableRead.mockRestore();
      }
      await restarted.resumeSessionRequests();
      expect(await restarted.readAsync(requestId)).toMatchObject(
        published(first.url, pullRequest.headSha),
      );
    }
    expect(await f.coordinator.readAsync(first.requestId)).toEqual(first);
    expect(f.externalWrites).toEqual(acceptedWrites);
    expect(f.publishedTitles).toEqual(["first-publication"]);
  },
);

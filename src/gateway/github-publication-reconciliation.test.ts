// Install shared transport mocks before publication owners enter the module cache.
// oxfmt-ignore
import {
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as sqliteQueries from "../infra/kysely-sync.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
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
  { backend: "repository", mode: "paged" },
  { backend: "repository", mode: "interrupted" },
] as const)(
  "reconciles a $mode $backend update after authority ends",
  async ({ backend, mode }) => {
    const { f, first, pullRequest, transport, observePush } =
      await prepareExistingPullRequest(backend);
    const closed = Array.from({ length: 30 }, (_, index) => ({
      ...pullRequest,
      url: pullRequest.url.replace(/\d+$/u, String(100 + index)),
      state: "closed",
      body: `<!-- openclaw-publication:earlier-closed-${index} -->`,
    }));
    let pushed = false,
      readbackAvailable = false,
      recoveryLookup = false,
      unavailableLookups = 0;
    let acceptedWrites: string[] = [];
    const hostScans = vi.spyOn(sqliteQueries, "iterateSqliteQuerySync");
    let recoveryScanStart = 0;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
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
        await observePush();
        if (mode === "paged") {
          await f.revoke();
        }
        pushed = true;
        recoveryScanStart = hostScans.mock.calls.length;
        acceptedWrites = [...f.externalWrites];
      }
      return response;
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

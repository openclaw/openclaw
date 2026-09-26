// Install shared transport mocks before publication owners enter the module cache.
// oxfmt-ignore
import {
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as sqliteQueries from "../infra/kysely-sync.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { createRequesterPublicationFixture } from "./github-publication-requester.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

const fixture = createRequesterPublicationFixture.bind(undefined, checkpoint);
type Backend = Parameters<typeof fixture>[0];

async function prepareExistingPullRequest(backend: Backend) {
  const f = await fixture(backend);
  const first = await f.coordinator.requestForSession(f.request("first-publication", f.guest));
  if (first.status !== "published") {
    throw new Error("The original fixture publication did not complete.");
  }
  const created = mocks.runCommand.mock.calls.findLast(
    ([argv]) => argv.includes("POST") && argv.some((arg: string) => arg.endsWith("/pulls")),
  );
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

describe("shared GitHub publication reconciliation", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(["local", "repository"] as const)(
    "finds an older open PR beyond the first page after an accepted %s push loses authority",
    async (backend) => {
      const { f, first, pullRequest, transport, observePush } =
        await prepareExistingPullRequest(backend);
      const closed = Array.from({ length: 30 }, (_, index) => ({
        ...pullRequest,
        url: pullRequest.url.replace(/\d+$/u, String(100 + index)),
        state: "closed",
        body: `<!-- openclaw-publication:earlier-closed-${index} -->`,
      }));
      let revoked = false;
      let recoveryLookup = false;
      let acceptedWrites: string[] | undefined;
      const hostScans = vi.spyOn(sqliteQueries, "iterateSqliteQuerySync");
      let recoveryScanStart = 0;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        if (argv.includes("state=all")) {
          recoveryLookup ||= revoked;
          // gh emits one compact JSON array per page; without pagination the open PR is absent.
          return commandResult(
            [closed, ...(argv.includes("--paginate") ? [[pullRequest]] : [])]
              .map((page) => JSON.stringify(page))
              .join("\n"),
          );
        }
        const response = await transport(argv, options);
        if (argv.includes("push") || argv.includes("graphql")) {
          await observePush();
          await f.revoke();
          revoked = true;
          recoveryScanStart = hostScans.mock.calls.length;
          acceptedWrites = [...f.externalWrites];
        }
        return response;
      });

      const result = await f.coordinator.requestForSession(f.request("paged-update", f.guest));

      expect(
        hostScans.mock.calls
          .slice(recoveryScanStart)
          .map(([, query]) => query.compile().sql)
          .filter((sql) => /from "github_(?:repository_)?publication_requests"/u.test(sql)),
      ).toEqual([]);

      expect(result).toMatchObject({
        status: "published",
        url: first.url,
        headCommit: pullRequest.headSha,
      });
      expect(result.requestId).not.toBe(first.requestId);
      expect(revoked).toBe(true);
      expect(recoveryLookup).toBe(true);
      expect(f.readReceipt(result.requestId)).toMatchObject({
        status: "published",
        pull_request_url: first.url,
        head_commit: pullRequest.headSha,
      });
      expect(f.externalWrites).toEqual(acceptedWrites);
      expect(f.publishedTitles).toEqual(["first-publication"]);
      await f.restart().resumeSessionRequests();
      expect(f.externalWrites).toEqual(acceptedWrites);
      expect(f.coordinator.read(first.requestId)).toEqual(first);
    },
  );

  it.each(["local", "repository"] as const)(
    "recovers an interrupted %s update to a known PR closed before requester-denied restart",
    async (backend) => {
      const { f, first, pullRequest, transport, observePush } =
        await prepareExistingPullRequest(backend);
      let pushed = false;
      let readbackAvailable = false;
      let unavailableLookups = 0;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        if (argv.includes("state=all")) {
          if (pushed && !readbackAvailable) {
            unavailableLookups += 1;
            return commandResult("", 1);
          }
          return commandResult(JSON.stringify([pullRequest]));
        }
        const response = await transport(argv, options);
        if (argv.includes("push") || argv.includes("graphql")) {
          await observePush();
          pushed = true;
        }
        return response;
      });

      const idempotencyKey = "interrupted-existing-pr-update";
      const pending = f.coordinator.requestForSession(f.request(idempotencyKey, f.guest));
      let requestId: string;
      if (backend === "local") {
        await expect(pending).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
        requestId = readGitHubPublicationRequest(f.database.db, {
          sessionId: f.session.sessionId,
          idempotencyKey,
        })!.request_id;
      } else {
        const result = await pending;
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
      expect(f.coordinator.read(first.requestId)).toEqual(first);
      const acceptedWrites = [...f.externalWrites];

      // The accepted update survives a later close; its existing PR retains the original body.
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
        expect(["requested", "publishing"]).toContain(f.readReceipt(requestId)?.status);
        expect(f.readReceipt(requestId)).toMatchObject({
          request_digest: pendingReceipt.request_digest,
          head_commit: pendingReceipt.head_commit,
          pull_request_url: null,
        });
        expect(f.externalWrites).toEqual(acceptedWrites);
      } finally {
        unavailableRead.mockRestore();
      }
      await restarted.resumeSessionRequests();

      expect(restarted.read(requestId)).toMatchObject({
        status: "published",
        url: first.url,
        headCommit: pullRequest.headSha,
      });
      expect(restarted.read(first.requestId)).toEqual(first);
      expect(f.externalWrites).toEqual(acceptedWrites);
      expect(f.publishedTitles).toEqual(["first-publication"]);
    },
  );
});

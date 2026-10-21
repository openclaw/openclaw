import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runGit } from "../../agents/worktrees/git.js";
import * as registryRead from "../../agents/worktrees/registry-read.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "../../agents/worktrees/registry.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import * as availability from "../github-publication-availability.js";
import { prepareGitHubPublicationTarget } from "../github-publication-target.js";
import { handleGatewayRequest } from "../server-methods.js";
import * as sessionStoreWorker from "../session-utils-store-worker.js";
import {
  publisher,
  receipt,
  sessionKey,
  withReadFixture,
} from "./sessions-github-read.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const guest = { personal: true, scopes: ["operator.sessions.write"] };
const sharedOptions = expect.objectContaining({ shared: publisher });
const githubOrigin = "https://github.com/example/project.git";
const repositoryChanged = "GitHub publication workspace repository changed.";
const publisherIdentity = {
  source: publisher.source,
  account: { accountId: publisher.accountId, login: publisher.login, avatarUrl: null },
};
type ReadFixture = Parameters<Parameters<typeof withReadFixture>[0]>[0];
type Worktree = Awaited<ReturnType<typeof registerWorktree>>;
const options = (fixture: ReadFixture) => fixture.invoke("sessions.github.options", { sessionKey });
const expectedOptions = (supported: boolean) => ({
  personal: null,
  shared: supported ? publisher : null,
  ...(!supported ? { sharedUnavailableReason: "unsupported_workspace" } : {}),
  pendingPersonal: null,
  latestShared: receipt,
});
function expectFailure(
  response: ReturnType<typeof vi.fn>,
  detail: { code?: string; message?: string },
) {
  expect(response).toHaveBeenCalledWith(false, undefined, expect.objectContaining(detail));
}
async function withWorktree(
  run: (fixture: ReadFixture, worktree: Worktree) => Promise<void>,
  origin: string | undefined = githubOrigin,
  bare = false,
) {
  await withReadFixture(
    async (fixture) => run(fixture, await registerWorktree(origin, bare)),
    guest,
  );
}

async function git(root: string, ...args: string[]) {
  expect((await runGit(root, args)).code).toBe(0);
}

beforeEach(() => {
  vi.spyOn(availability, "prepareCurrentGitHubPublicationOptionsIdentity").mockResolvedValue(
    publisherIdentity,
  );
});
afterEach(() => vi.restoreAllMocks());

async function registerWorktree(origin?: string, bare = false) {
  let root = await fs.realpath(temporary.make("publication-read-target-"));
  await git(root, "init", "--initial-branch=feature");
  await git(root, "config", "user.name", "Publication Fixture");
  await git(root, "config", "user.email", "publication@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "commit", "--allow-empty", "-m", "fixture");
  if (bare) {
    const repository = `${root}/bare.git`;
    const checkout = `${root}/checkout`;
    await git(root, "clone", "--bare", root, repository);
    await git(repository, "remote", "remove", "origin");
    await git(repository, "worktree", "add", checkout, "feature");
    root = checkout;
  }
  if (origin) {
    await git(root, "remote", "add", "origin", origin);
  }
  const identity = await managedWorktrees.resolveRepositoryIdentity(root);
  const worktree = {
    id: "publication-read-worktree",
    name: "publication-read-worktree",
    path: root,
    repoRoot: identity.repoRoot,
    repoFingerprint: identity.fingerprint,
    branch: "feature",
    baseRef: "main",
    ownerKind: "session" as const,
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  };
  await insertRegistryWorktree(process.env, worktree);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    { worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot } },
  );
  return worktree;
}

describe("registered guest publication target discovery", () => {
  it.each([false, true])(
    "shares repository discovery across linked sessions (bare root: %s)",
    async (bare) => {
      await withWorktree(
        async (fixture, worktree) => {
          const keys = [sessionKey];
          for (let index = 1; index <= 2; index++) {
            const key = `${sessionKey}-${index}`;
            const linked = {
              ...worktree,
              id: `${worktree.id}-${index}`,
              path: `${worktree.path}/linked-${index}`,
              branch: `feature-${index}`,
              ownerId: key,
            };
            await git(worktree.path, "worktree", "add", "-b", linked.branch, linked.path);
            await insertRegistryWorktree(process.env, linked);
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: key },
              {
                sessionId: `linked-session-${index}`,
                updatedAt: 1,
                worktree: { id: linked.id, branch: linked.branch, repoRoot: linked.repoRoot },
              },
            );
            keys.push(key);
          }
          try {
            const lookup = vi.spyOn(managedWorktrees, "resolveRepositoryIdentity");
            const sessionReads = vi.spyOn(
              sessionStoreWorker,
              "loadGatewaySessionEntryReadOnlyInWorker",
            );
            const responses = await Promise.all(
              keys.map((key) => fixture.invoke("sessions.github.options", { sessionKey: key })),
            );
            for (const response of responses) {
              expect(response).toHaveBeenCalledWith(true, sharedOptions);
            }
            expect(lookup).toHaveBeenCalledOnce();
            expect(sessionReads).toHaveBeenCalledTimes(keys.length);

            // A revised registry identity cannot borrow the previous repository's positive facts.
            await updateRegistryWorktree(process.env, `${worktree.id}-1`, {
              repositoryIdentity: { repoRoot: worktree.repoRoot, repoFingerprint: "changed" },
            });
            expectFailure(
              await fixture.invoke("sessions.github.options", { sessionKey: keys[1] }),
              {
                message: repositoryChanged,
              },
            );
            expect(await options(fixture)).toHaveBeenCalledWith(true, sharedOptions);
          } finally {
            for (let index = 1; index <= 2; index++) {
              await git(worktree.path, "worktree", "remove", `${worktree.path}/linked-${index}`);
            }
          }
        },
        githubOrigin,
        bare,
      );
    },
  );

  it("shares Git discovery across concurrent options readers", async () => {
    await withWorktree(async (fixture) => {
      const readers = 8;
      const ready = createDeferredCore();
      const readOwner = registryRead.readLiveRegistryWorktreeByOwner;
      let arrived = 0;
      vi.spyOn(registryRead, "readLiveRegistryWorktreeByOwner").mockImplementation(
        async (...args) => {
          const owner = await readOwner(...args);
          if (++arrived === readers) {
            ready.resolve();
          }
          await ready.promise;
          return owner;
        },
      );
      const lookup = vi.spyOn(managedWorktrees, "resolveRepositoryIdentity");
      const responses = await Promise.all(Array.from({ length: readers }, () => options(fixture)));
      for (const response of responses) {
        expect(response).toHaveBeenCalledWith(true, sharedOptions);
      }
      expect(lookup).toHaveBeenCalledOnce();
    });
  });

  it("reuses positive target discovery for 15 seconds while publication still checks live Git", async () => {
    await withWorktree(async (fixture, worktree) => {
      const lookup = vi.spyOn(managedWorktrees, "resolveRepositoryIdentity");
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      for (let index = 0; index < 2; index++) {
        expect(await options(fixture)).toHaveBeenCalledWith(true, sharedOptions);
      }
      expect(lookup).toHaveBeenCalledOnce();
      await git(worktree.path, "remote", "set-url", "origin", "https://example.test/repo.git");
      now += 14_999;
      expect(await options(fixture)).toHaveBeenCalledWith(true, sharedOptions);
      expect(lookup).toHaveBeenCalledOnce();
      await expect(
        prepareGitHubPublicationTarget({
          worktree,
          identity: { ...publisherIdentity, env: {} },
          assertCurrent: () => {},
        }),
      ).rejects.toThrow(repositoryChanged);
      now += 1;
      expectFailure(await options(fixture), { message: repositoryChanged });
    });
  });

  it("checks the current connection on cached discovery hits", async () => {
    await withWorktree(async (fixture) => {
      expect(await options(fixture)).toHaveBeenCalledWith(true, sharedOptions);
      const lookup = vi.spyOn(managedWorktrees, "resolveRepositoryIdentity");
      expect(await options(fixture)).toHaveBeenCalledWith(true, sharedOptions);
      expect(lookup).not.toHaveBeenCalled();
      fixture.disconnect();
      expectFailure(await options(fixture), { code: "FORBIDDEN" });
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  it.each([undefined, "https://example.test/project.git"])(
    "keeps receipts for unsupported origin %s and rejects stale or failed repository reads",
    async (origin) => {
      await withWorktree(async (fixture, worktree) => {
        expect(await options(fixture)).toHaveBeenCalledWith(true, expectedOptions(false));
        if (origin) {
          vi.spyOn(managedWorktrees, "resolveRepositoryIdentity").mockRejectedValueOnce(
            new Error("Repository read unavailable"),
          );
        } else {
          await git(worktree.path, "remote", "add", "origin", githubOrigin);
        }
        expectFailure(await options(fixture), {
          message: origin ? "Repository read unavailable" : repositoryChanged,
        });
        if (origin) {
          expect(
            await fixture.invoke("sessions.github.status", {
              sessionKey,
              requestId: receipt.result.requestId,
            }),
          ).toHaveBeenCalledWith(true, receipt);
        } else {
          const identity = await managedWorktrees.resolveRepositoryIdentity(worktree.path);
          await updateRegistryWorktree(process.env, worktree.id, {
            repositoryIdentity: {
              repoRoot: identity.repoRoot,
              repoFingerprint: identity.fingerprint,
            },
          });
          expect(await options(fixture)).toHaveBeenCalledWith(true, expectedOptions(true));
          expect(fixture.personalConnectionStatus).not.toHaveBeenCalled();
          expect(fixture.requestForSession).not.toHaveBeenCalled();
        }
      }, origin ?? "");
    },
  );

  it.each(["connection", "worktree", "session worktree"] as const)(
    "rejects a changed %s during repository discovery",
    async (change) => {
      await withWorktree(async (fixture, worktree) => {
        const identity = await managedWorktrees.resolveRepositoryIdentity(worktree.path);
        const entered = createDeferredCore();
        const pending = createDeferredCore<typeof identity>();
        vi.spyOn(managedWorktrees, "resolveRepositoryIdentity").mockImplementationOnce(() => {
          entered.resolve();
          return pending.promise;
        });
        const respond = vi.fn();
        const request = fixture.invoke("sessions.github.options", { sessionKey }, respond);
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            request,
            "Repository read did not start",
          );
          if (change === "connection") {
            fixture.disconnect();
          } else if (change === "session worktree") {
            await upsertSessionEntryCore({ agentId: "main", sessionKey }, { worktree: undefined });
          } else {
            await updateRegistryWorktree(process.env, worktree.id, { removedAt: 2 });
          }
          pending.resolve(identity);
          await request;
          expectFailure(respond, { code: "FORBIDDEN" });
          expect(respond).toHaveBeenCalledOnce();
        } finally {
          pending.resolve(identity);
          await request;
        }
      });
    },
  );

  it.each([githubOrigin, "https://example.test/project.git"])(
    "qualifies the current repository workspace %s without GitHub API calls",
    async (url) => {
      await withReadFixture(async (fixture) => {
        const workspace = await getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey,
          url,
          branch: "feature",
          assertCurrent: () => {},
        });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { repositoryWorkspaceId: workspace.workspaceId },
        );
        const localLookup = vi.spyOn(managedWorktrees, "resolveRepositoryIdentity");
        expect(await options(fixture)).toHaveBeenCalledWith(
          true,
          expectedOptions(url.includes("github.com")),
        );
        expect(localLookup).not.toHaveBeenCalled();
        expect(fixture.requestForSession).not.toHaveBeenCalled();
      }, guest);
    },
  );

  it.each(["broad", "internal"] as const)(
    "preserves %s account discovery without a publication workspace",
    async (caller) => {
      await withReadFixture(async (fixture) => {
        const target = vi.spyOn(availability, "hasSupportedGitHubPublicationTarget");
        const respond = caller === "broad" ? await options(fixture) : vi.fn();
        if (caller === "internal") {
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "internal-publication-options",
              method: "sessions.github.options",
              params: { sessionKey },
            },
            client: null,
            context: fixture.context,
            isWebchatConnect: () => false,
            respond,
          });
        }
        expect(respond).toHaveBeenCalledWith(true, sharedOptions);
        expect(target).not.toHaveBeenCalled();
      });
    },
  );
});

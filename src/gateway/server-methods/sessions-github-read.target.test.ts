import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runGit } from "../../agents/worktrees/git.js";
import * as registryRead from "../../agents/worktrees/registry-read.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "../../agents/worktrees/registry.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { makeWorktreeRecord } from "../../agents/worktrees/service.test-support.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import * as availability from "../github-publication-availability.js";
import { prepareGitHubPublicationTarget } from "../github-publication-target.js";
import { handleGatewayRequest } from "../server-methods.js";
import * as sessionStoreWorker from "../session-utils-store-worker.js";
import {
  expectFailure,
  expectNoCalls,
  expectNoPersonalReads,
  expectReply,
  mockPublicationIdentity,
  optionsResult,
  publisher,
  publisherIdentity,
  receipt,
  sessionKey,
  withHeldReceipt,
  withReadFixture,
  type ReadFixture,
} from "./sessions-github-read.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const guest = { personal: true, scopes: ["operator.sessions.write"] };
const sharedOptions = expect.objectContaining({ shared: publisher });
const githubOrigin = "https://github.com/example/project.git";
const repositoryChanged = "GitHub publication workspace repository changed.";
type Worktree = Awaited<ReturnType<typeof registerWorktree>>;
const options = (fixture: ReadFixture) => fixture.invoke("sessions.github.options", { sessionKey });
const expectedOptions = (supported: boolean) =>
  optionsResult({
    shared: supported ? publisher : null,
    ...(!supported ? { sharedUnavailableReason: "unsupported_workspace" } : {}),
  });
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

beforeEach(mockPublicationIdentity);
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
  const worktree = makeWorktreeRecord(identity.repoRoot, "publication-read-worktree", {
    path: root,
    repoFingerprint: identity.fingerprint,
    branch: "feature",
    baseRef: "main",
    ownerId: sessionKey,
  });
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
              expectReply(response, sharedOptions);
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
            expectReply(await options(fixture), sharedOptions);
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
        expectReply(response, sharedOptions);
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
        expectReply(await options(fixture), sharedOptions);
      }
      expect(lookup).toHaveBeenCalledOnce();
      await git(worktree.path, "remote", "set-url", "origin", "https://example.test/repo.git");
      now += 14_999;
      expectReply(await options(fixture), sharedOptions);
      expect(lookup).toHaveBeenCalledOnce();
      await expect(
        prepareGitHubPublicationTarget({
          worktree,
          identity: { ...publisherIdentity(), env: {} },
          assertCurrent: () => {},
        }),
      ).rejects.toThrow(repositoryChanged);
      now += 1;
      expectFailure(await options(fixture), { message: repositoryChanged });
    });
  });

  it("checks the current connection on cached discovery hits", async () => {
    await withWorktree(async (fixture) => {
      expectReply(await options(fixture), sharedOptions);
      const lookup = vi.spyOn(managedWorktrees, "resolveRepositoryIdentity");
      expectReply(await options(fixture), sharedOptions);
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
        expectReply(await options(fixture), expectedOptions(false));
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
          expectReply(
            await fixture.invoke("sessions.github.status", {
              sessionKey,
              requestId: receipt.result.requestId,
            }),
            receipt,
          );
        } else {
          const identity = await managedWorktrees.resolveRepositoryIdentity(worktree.path);
          await updateRegistryWorktree(process.env, worktree.id, {
            repositoryIdentity: {
              repoRoot: identity.repoRoot,
              repoFingerprint: identity.fingerprint,
            },
          });
          expectReply(await options(fixture), expectedOptions(true));
          expectNoCalls(fixture.personalConnectionStatus, fixture.requestForSession);
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
        expectReply(await options(fixture), expectedOptions(url.includes("github.com")));
        expectNoCalls(localLookup, fixture.requestForSession);
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
        expectReply(respond, sharedOptions);
        expect(target).not.toHaveBeenCalled();
      });
    },
  );
});

describe.each(["options", "status"] as const)("registered guest sessions.github.%s", (method) => {
  it.each([
    ["read", false, "view", false],
    ["write", false, "view", false],
    ["write", true, "view", false],
    ["write", true, "none", false],
    ...(method === "status" ? [["write", false, "view", true] as const] : []),
  ] as const)(
    "keeps %s foreign=%s others=%s missing=%s visibility and personal boundaries",
    async (scope, foreign, others, missing) => {
      await withReadFixture(
        async (fixture) => {
          if (missing) {
            fixture.sharedStatus.mockResolvedValue(undefined);
          }
          const respond = await fixture[method]();
          if (foreign && others === "none") {
            expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
            expect(fixture.latestShared).not.toHaveBeenCalled();
            expect(fixture.sharedStatus).not.toHaveBeenCalled();
          } else if (missing) {
            expectFailure(respond);
            expect(fixture.sharedStatus).toHaveBeenCalledOnce();
          } else {
            expectReply(
              respond,
              method === "options"
                ? optionsResult({ shared: null, sharedUnavailableReason: "unsupported_workspace" })
                : receipt,
            );
          }
          expectNoPersonalReads(fixture);
        },
        { personal: true, scopes: [`operator.sessions.${scope}`], others, foreign },
      );
    },
  );

  it.each(["scope", "role", "profile", "grant", "connection", "visibility", "lifecycle"] as const)(
    "rejects %s loss during an awaited receipt read",
    async (change) => {
      await withReadFixture(
        async (fixture) => {
          const granted = new AbortController();
          fixture.client.internal = {
            operatorAccessAuthority: {
              signal: granted.signal,
              assertCurrent: () => granted.signal.throwIfAborted(),
            },
          };
          await withHeldReceipt(
            fixture,
            method === "options" ? "shared" : "status",
            async (respond, release) => {
              const profile = expectDefined(
                fixture.client.authenticatedUserProfile,
                "guest profile",
              );
              const updateSession = (patch: Parameters<typeof upsertSessionEntryCore>[1]) =>
                upsertSessionEntryCore({ agentId: "main", sessionKey }, patch);
              await {
                scope: () => {
                  fixture.client.connect.scopes = [];
                },
                role: () => setCanonicalUserProfileRole(profile.profileId, "blocked"),
                profile: () => {
                  profile.profileId = ensureProfileForEmail(
                    "replacement-publication-reader@example.test",
                  ).id;
                },
                grant: () => granted.abort(),
                connection: fixture.disconnect,
                visibility: () => updateSession({ visibility: "draft" }),
                lifecycle: () => updateSession({ lifecycleRevision: "replaced-publication" }),
              }[change]();
              await release(receipt);
              expectFailure(respond);
              expect(respond).toHaveBeenCalledOnce();
              expectNoPersonalReads(fixture);
            },
          );
        },
        {
          personal: true,
          scopes: ["operator.sessions.write"],
          others: change === "visibility" ? "view" : "none",
          foreign: change === "visibility",
        },
      );
    },
  );
});

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
) {
  await withReadFixture(async (fixture) => run(fixture, await registerWorktree(origin)), guest);
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

async function registerWorktree(origin?: string) {
  const root = await fs.realpath(temporary.make("publication-read-target-"));
  await git(root, "init", "--initial-branch=feature");
  await git(root, "config", "user.name", "Publication Fixture");
  await git(root, "config", "user.email", "publication@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "commit", "--allow-empty", "-m", "fixture");
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

  it.each(["connection", "worktree"] as const)(
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

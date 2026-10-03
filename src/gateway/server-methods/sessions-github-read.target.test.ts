import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runGit } from "../../agents/worktrees/git.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "../../agents/worktrees/registry.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import * as availability from "../github-publication-availability.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  publisher,
  receipt,
  sessionKey,
  withReadFixture,
} from "./sessions-github-read.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const guest = { personal: true, scopes: ["operator.sessions.write"] };

beforeEach(() => {
  vi.spyOn(availability, "prepareCurrentGitHubPublicationOptionsIdentity").mockResolvedValue({
    source: publisher.source,
    account: { accountId: publisher.accountId, login: publisher.login, avatarUrl: null },
  });
});
afterEach(() => vi.restoreAllMocks());

async function registerWorktree(origin?: string) {
  const root = await fs.realpath(temporary.make("publication-read-target-"));
  expect((await runGit(root, ["init", "--initial-branch=feature"])).code).toBe(0);
  expect(
    (
      await runGit(root, [
        "-c",
        "user.name=Publication Fixture",
        "-c",
        "user.email=publication@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ])
    ).code,
  ).toBe(0);
  if (origin) {
    expect((await runGit(root, ["remote", "add", "origin", origin])).code).toBe(0);
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
  insertRegistryWorktree(process.env, worktree);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
    },
  );
  return worktree;
}

describe("registered guest publication target discovery", () => {
  it.each([undefined, "https://example.test/project.git"])(
    "keeps receipts for unsupported origin %s and rejects stale or failed repository reads",
    async (origin) => {
      await withReadFixture(async (fixture) => {
        const worktree = await registerWorktree(origin);
        const unavailable = await fixture.invoke("sessions.github.options", { sessionKey });
        expect(unavailable).toHaveBeenCalledWith(true, {
          personal: null,
          shared: null,
          pendingPersonal: null,
          latestShared: receipt,
        });
        if (origin) {
          vi.spyOn(managedWorktrees, "resolveRepositoryIdentity").mockRejectedValueOnce(
            new Error("Repository read unavailable"),
          );
        } else {
          expect(
            (
              await runGit(worktree.path, [
                "remote",
                "add",
                "origin",
                "https://github.com/example/project.git",
              ])
            ).code,
          ).toBe(0);
        }
        const failed = await fixture.invoke("sessions.github.options", { sessionKey });
        expect(failed).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: origin
              ? "Repository read unavailable"
              : "GitHub publication workspace repository changed.",
          }),
        );
        if (origin) {
          expect(
            await fixture.invoke("sessions.github.status", {
              sessionKey,
              requestId: receipt.result.requestId,
            }),
          ).toHaveBeenCalledWith(true, receipt);
        } else {
          const identity = await managedWorktrees.resolveRepositoryIdentity(worktree.path);
          updateRegistryWorktree(process.env, worktree.id, {
            repositoryIdentity: {
              repoRoot: identity.repoRoot,
              repoFingerprint: identity.fingerprint,
            },
          });
          const current = await fixture.invoke("sessions.github.options", { sessionKey });
          expect(current).toHaveBeenCalledWith(true, {
            personal: null,
            shared: publisher,
            pendingPersonal: null,
            latestShared: receipt,
          });
          expect(fixture.personalConnectionStatus).not.toHaveBeenCalled();
          expect(fixture.requestForSession).not.toHaveBeenCalled();
        }
      }, guest);
    },
  );

  it.each(["connection", "worktree"] as const)(
    "rejects a changed %s during repository discovery",
    async (change) => {
      await withReadFixture(async (fixture) => {
        const worktree = await registerWorktree("https://github.com/example/project.git");
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
            updateRegistryWorktree(process.env, worktree.id, { removedAt: 2 });
          }
          pending.resolve(identity);
          await request;
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({ code: "FORBIDDEN" }),
          );
        } finally {
          pending.resolve(identity);
          await request;
        }
      }, guest);
    },
  );

  it.each(["https://github.com/example/project.git", "https://example.test/project.git"])(
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
        expect(
          await fixture.invoke("sessions.github.options", { sessionKey }),
        ).toHaveBeenCalledWith(true, {
          personal: null,
          shared: url.includes("github.com") ? publisher : null,
          pendingPersonal: null,
          latestShared: receipt,
        });
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
        const respond =
          caller === "broad"
            ? await fixture.invoke("sessions.github.options", { sessionKey })
            : vi.fn();
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
        expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ shared: publisher }));
        expect(target).not.toHaveBeenCalled();
      });
    },
  );
});

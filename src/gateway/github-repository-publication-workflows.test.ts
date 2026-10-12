// Register shared transport mocks before publication owners load.
// oxfmt-ignore
import {
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import {
  createRequesterPublicationFixture,
  guestScopes,
  holdWorkerTurn,
} from "./github-publication-requester.test-support.js";
import * as repositoryPublicationExecutor from "./github-repository-publication-executor.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

const workflow = ".github/workflows/example.yaml";
const definition = "name: synthetic\non: workflow_dispatch\njobs: {}\n";
const createFixture = async (baseFiles: Record<string, string> = {}, requestedRef?: string) => {
  const f = await createRequesterPublicationFixture(
    checkpoint,
    "repository",
    { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
    { baseFiles, requestedRef },
  );
  if (!f.repository) {
    throw new Error("Expected a repository publication fixture.");
  }
  return { ...f, repository: f.repository };
};
const rejected = {
  status: "failed",
  code: "github_rejected",
  nextAction: expect.stringContaining("Ask a maintainer"),
};
const writes = () => mocks.runCommand.mock.calls.filter(([args]) => args.includes("POST"));

describe("repository checkpoint workflow authority", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(["add", "modify", "delete", "source-commit"] as const)(
    "rejects %s workflow changes before upload and retains the checkpoint",
    async (operation) => {
      const f = await createFixture(
        operation === "add" ? {} : { [workflow]: definition },
        operation === "source-commit" ? "topic" : undefined,
      );
      if (operation === "source-commit") {
        const { runtime, git, baseCommit } = f.repository;
        runtime.mergeBase = git(["rev-parse", baseCommit + "^"]);
        runtime.mergeBaseTree = git(["rev-parse", runtime.mergeBase + "^{tree}"]);
        runtime.baseHead = runtime.mergeBase;
        runtime.baseHeadTree = runtime.mergeBaseTree;
      }
      const saved =
        operation === "source-commit"
          ? undefined
          : await f.repository.capture("accepted code\n", operation, {
              [workflow]: operation === "delete" ? null : definition + "# accepted change\n",
            });
      const result = await f.coordinator.requestForSession(f.request(operation, f.guest));
      expect(result).toMatchObject(rejected);
      expect(writes()).toEqual([]);
      if (saved) {
        expect(f.repository.runtime.effects).toEqual([]);
        expect(
          (await getSessionRepositoryWorkspaceStore().get(f.repository.workspace.workspaceId))
            ?.checkpointRef,
        ).toBe(saved.ref);
        const calls = mocks.runCommand.mock.calls.length;
        expect(await f.coordinator.requestForSession(f.request(operation, f.guest))).toEqual(
          result,
        );
        expect(mocks.runCommand.mock.calls).toHaveLength(calls);
      }
    },
  );

  it("publishes ordinary guest changes with unchanged workflows and reuses immutable tree reads", async () => {
    const f = await createFixture({ [workflow]: definition });
    await f.repository.capture("ordinary code\n", "ordinary", {
      ".github/workflows/README.md": "workflow documentation\n",
    });
    expect(
      await f.coordinator.requestForSessionV2({
        ...f.request("ordinary", f.guest),
        requester: f.guest,
      }),
    ).toMatchObject({ status: "published" });
    expect(f.repository.runtime.effects).toEqual(["push", "pull_request"]);
    const trees = mocks.runCommand.mock.calls.filter(([args]) =>
      args.some((arg: string) => arg.includes("/git/trees/")),
    );
    expect(trees.length).toBeLessThanOrEqual(3);
    expect(
      new Set(trees.map(([args]) => args.find((arg: string) => arg.includes("/git/trees/")))).size,
    ).toBe(trees.length);
  });

  it("preserves a maintainer-published workflow in guest updates but rejects its removal", async () => {
    const f = await createFixture();
    await f.repository.capture("maintainer code\n", "maintainer", { [workflow]: definition });
    expect(
      await f.coordinator.requestForSession(f.request("maintainer", f.maintainer)),
    ).toMatchObject({ status: "published" });
    expect(
      mocks.runCommand.mock.calls.some(([args]) =>
        args.some((arg: string) => arg.includes("/git/trees/")),
      ),
    ).toBe(false);
    await f.repository.capture("guest code\n", "guest", { [workflow]: definition });
    expect(await f.coordinator.requestForSession(f.request("guest", f.guest))).toMatchObject({
      status: "published",
    });
    const effectCount = writes().length;
    const saved = await f.repository.capture("retained guest code\n", "restore-source");
    expect(
      await f.coordinator.requestForSession(f.request("restore-source", f.guest)),
    ).toMatchObject(rejected);
    expect(writes()).toHaveLength(effectCount);
    expect(
      (await getSessionRepositoryWorkspaceStore().get(f.repository.workspace.workspaceId))
        ?.checkpointRef,
    ).toBe(saved.ref);
  });

  it.each([false, true])(
    "inherits target-only checkpoint workflows while preserving approved definitions (update=%s)",
    async (update) => {
      const removed = ".github/workflows/removed.yml";
      const renamed = ".github/workflows/renamed.yml";
      const renamedTo = ".github/workflows/new-name.yml";
      const conflict = ".github/workflows/conflict.yml";
      const f = await createFixture({
        [workflow]: definition,
        [removed]: definition,
        [renamed]: definition,
        [conflict]: definition,
      });
      const { git, runtime, baseCommit, capture } = f.repository;
      const approved = definition + "# branch-approved\n";
      if (update) {
        await capture("initial source\n", "initial", { [conflict]: approved });
        expect(
          await f.coordinator.requestForSession(f.request("initial", f.maintainer)),
        ).toMatchObject({ status: "published" });
      }
      const upstream = {
        [workflow]: definition + "# target update\n",
        [removed]: null,
        [renamed]: null,
        [renamedTo]: definition,
        [conflict]: definition + "# target conflict\n",
      };
      const target = await capture(null, "target", upstream);
      runtime.baseHead = git(
        ["commit-tree", target.workspaceTree, "-p", baseCommit],
        "target workflows\n",
      );
      runtime.baseHeadTree = target.workspaceTree;
      const accepted = { ...upstream, ...(update ? { [conflict]: approved } : {}) };
      await capture("source after target update\n", "inherited", accepted);
      const result = await f.coordinator.requestForSession(f.request("inherited", f.guest));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "published" });
      expect(git(["show", runtime.head + ":" + workflow])).toBe(upstream[workflow].trim());
      if (update) {
        expect(git(["show", runtime.head + ":" + conflict])).toBe(approved.trim());
        const before = writes().length;
        await capture("conflicting resolution\n", "conflict", upstream);
        expect(await f.coordinator.requestForSession(f.request("conflict", f.guest))).toMatchObject(
          rejected,
        );
        expect(writes()).toHaveLength(before);
      }
    },
  );

  it.each(["foreign", "stale", "diverged", "caller-revoked", "publisher-revoked"] as const)(
    "does not exempt an inherited checkpoint with %s target or authority facts",
    async (failure) => {
      const f = await createFixture({ [workflow]: definition });
      const { git, runtime, baseCommit, capture } = f.repository;
      const candidate = definition + "# candidate upstream\n";
      const target = await capture(null, "target", {
        [workflow]:
          failure === "foreign"
            ? definition
            : failure === "stale"
              ? definition + "# newer target\n"
              : candidate,
      });
      const accepted = await capture("accepted source\n", "candidate", { [workflow]: candidate });
      const candidateCommit = git(
        ["commit-tree", accepted.workspaceTree, "-p", baseCommit],
        "candidate workflows\n",
      );
      const parent =
        failure === "diverged"
          ? git(["rev-parse", baseCommit + "^"])
          : failure === "stale"
            ? candidateCommit
            : baseCommit;
      runtime.baseHead = git(
        ["commit-tree", target.workspaceTree, "-p", parent],
        "authenticated target\n",
      );
      runtime.mergeBase = git(["merge-base", baseCommit, runtime.baseHead]);
      runtime.mergeBaseTree = git(["rev-parse", runtime.mergeBase + "^{tree}"]);
      runtime.baseHeadTree = target.workspaceTree;
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (args, options) => {
        if (failure === "foreign") {
          const endpoint = args.find((arg: string) => arg.startsWith("repos/")) ?? "";
          if (endpoint === "repos/owner/repository") {
            return commandResult(
              JSON.stringify({
                node_id: "repository-node",
                fork: true,
                default_branch: "main",
                parent: {
                  name: "repository",
                  owner: { login: "upstream" },
                  default_branch: "main",
                },
              }),
            );
          }
          if (endpoint === "repos/owner/repository/git/ref/heads/main") {
            return commandResult(
              JSON.stringify({ ref: "refs/heads/main", object: { sha: candidateCommit } }),
            );
          }
          if (endpoint.endsWith("/git/commits/" + candidateCommit)) {
            return commandResult(
              JSON.stringify({ sha: candidateCommit, tree: { sha: accepted.workspaceTree } }),
            );
          }
          if (endpoint.includes("/compare/")) {
            const [source, head] = endpoint.split("/compare/")[1]!.split("?")[0]!.split("...");
            return commandResult(JSON.stringify({ sha: git(["merge-base", source!, head!]) }));
          }
        }
        const result = await transport(args, options);
        if (args.some((arg: string) => arg.endsWith("/git/trees/" + target.workspaceTree))) {
          if (failure === "caller-revoked") {
            await f.revoke();
          } else if (failure === "publisher-revoked") {
            mocks.matchesIdentity.mockReturnValue(false);
          }
        }
        return result;
      });
      const result = await f.coordinator.requestForSession(f.request(failure, f.guest));
      expect(result).toMatchObject(
        failure.endsWith("revoked") ? { status: "failed", code: "identity_changed" } : rejected,
      );
      expect(writes()).toEqual([]);
      expect(runtime.effects).toEqual([]);
    },
  );

  it("retains the original workflow scope after deferral, promotion, and coordinator restart", async () => {
    const f = await createRequesterPublicationFixture(checkpoint, "repository");
    if (!f.repository) {
      throw new Error("Expected a repository publication fixture.");
    }
    const saved = await f.repository.capture("accepted code\n", "deferred-workflow", {
      [workflow]: definition,
    });
    const claim = await holdWorkerTurn(f);
    const accepted = await f.coordinator.requestForSession(f.request("deferred-workflow", f.guest));
    expect(accepted.status).toBe("requested");
    const original = f.readRequester(accepted.requestId);
    expect(original?.scopes).toEqual(guestScopes);
    await setCanonicalUserProfileRole(f.guestProfile, "maintainer");
    invalidateOperatorRolePolicy(f.guestProfile);
    await f.placements.releaseTurn(claim);
    f.guestSource.release();

    const restarted = f.restart();
    await restarted.resumeSessionRequests();
    expect(restarted.read(accepted.requestId)).toMatchObject(rejected);
    expect(f.readRequester(accepted.requestId)).toEqual(original);
    expect(f.externalWrites).toEqual([]);
    expect(
      (await getSessionRepositoryWorkspaceStore().get(f.repository.workspace.workspaceId))
        ?.checkpointRef,
    ).toBe(saved.ref);
  });

  it.each(["truncated", "different-tree"] as const)(
    "refuses a %s workflow tree observation before upload",
    async (failure) => {
      const f = await createFixture();
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (args, options) => {
        if (args.some((arg: string) => arg.includes("/git/trees/"))) {
          return commandResult(
            JSON.stringify({
              sha: failure === "different-tree" ? "a".repeat(40) : f.repository.baseTree,
              tree: [],
              truncated: failure === "truncated",
            }),
          );
        }
        return await transport(args, options);
      });
      expect(await f.coordinator.requestForSession(f.request(failure, f.guest))).toMatchObject({
        status: "failed",
        code: "unavailable",
      });
      expect(writes()).toEqual([]);
    },
  );

  it("rechecks workflow authority after a blob response before writing the tree or branch", async () => {
    const f = await createFixture();
    await f.repository.capture("accepted code\n", "authority-change", { [workflow]: definition });
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, options) => {
      const result = await transport(args, options);
      if (args.some((arg: string) => arg.endsWith("/git/blobs"))) {
        await setCanonicalUserProfileRole(f.maintainerProfile, "revoked");
        invalidateOperatorRolePolicy(f.maintainerProfile);
      }
      return result;
    });
    expect(
      await f.coordinator.requestForSession(f.request("authority-change", f.maintainer)),
    ).toMatchObject({ status: "failed", code: "identity_changed" });
    expect(f.repository.runtime.uploaded.size).toBeGreaterThan(0);
    expect(f.repository.runtime.effects).toEqual([]);
    expect(writes().every(([args]) => args.some((arg: string) => arg.endsWith("/git/blobs")))).toBe(
      true,
    );
  });

  it("rechecks the publisher after workflow authorization at the ref update boundary", async () => {
    const f = await createFixture();
    await f.repository.capture("accepted code\n", "publisher-at-ref", { [workflow]: definition });
    const execute = repositoryPublicationExecutor.executeRepositoryGitHubPublication;
    let pushRecorded = false;
    let publisherRevoked = false;
    const intercepted = vi
      .spyOn(repositoryPublicationExecutor, "executeRepositoryGitHubPublication")
      .mockImplementation((params) =>
        execute({
          ...params,
          execution: {
            ...params.execution,
            recordEffect: async (effect, observed) => {
              await params.execution.recordEffect(effect, observed);
              if (effect === "push" && observed === undefined) {
                pushRecorded = true;
              }
            },
          },
          assertWorkflowChangesAllowed: () => {
            params.assertWorkflowChangesAllowed();
            if (pushRecorded) {
              publisherRevoked = true;
              mocks.matchesIdentity.mockReturnValue(false);
            }
          },
        }),
      );
    onTestFinished(() => intercepted.mockRestore());

    expect(
      await f.coordinator.requestForSession(f.request("publisher-at-ref", f.maintainer)),
    ).toMatchObject({ status: "requested" });
    expect(publisherRevoked).toBe(true);
    expect(f.maintainer.assertCurrent).not.toThrow();
    expect(f.repository.runtime.uploaded.size).toBeGreaterThan(0);
    expect(f.repository.casRequests).toEqual([]);
    expect(f.repository.runtime.effects).toEqual([]);
  });
});

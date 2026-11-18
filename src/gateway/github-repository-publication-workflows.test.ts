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
import {
  observeRepositoryCommands,
  type RepositoryPublicationSourceHistory,
} from "./github-repository-publication.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
// mock-isolation: Synthetic checkpoints isolate publication from real repository and session state.
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryPublicationCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

const workflow = ".github/workflows/example.yaml";
const definition = "name: synthetic\non: workflow_dispatch\njobs: {}\n";
const published = { status: "published" };
const identityChanged = { status: "failed", code: "identity_changed" };
const createFixture = async (
  baseFiles: Record<string, string> = {},
  requestedRef?: string,
  sourceHistory?: RepositoryPublicationSourceHistory,
) => {
  const f = await createRequesterPublicationFixture(
    checkpoint,
    "repository",
    { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
    { baseFiles, requestedRef, sourceHistory },
  );
  if (!f.repository) {
    throw new Error("Expected a repository publication fixture.");
  }
  const { git, runtime, baseCommit } = f.repository;
  return {
    ...f,
    repository: f.repository,
    publish: (key: string, requester = f.guest) =>
      f.coordinator.requestForSessionV2(f.request(key, requester)),
    commitTree: (tree: string, parent = baseCommit) =>
      git(["commit-tree", tree, "-p", parent], "candidate workflows\n"),
    targetTree: (tree: string, parent = baseCommit, message = "target workflows\n") => {
      runtime.baseHead = git(["commit-tree", tree, "-p", parent], message);
      runtime.baseHeadTree = tree;
    },
  };
};
const rejected = {
  status: "failed",
  code: "github_rejected",
  nextAction: expect.stringContaining("Ask a maintainer"),
};
const writes = () => mocks.runCommand.mock.calls.filter(([args]) => args.includes("POST"));
const treeReads = () =>
  mocks.runCommand.mock.calls.flatMap(([args]) =>
    args.filter((arg: string) => arg.includes("/git/trees/")),
  );
const json = (value: unknown) => commandResult(JSON.stringify(value));
const checkpointRef = async (f: { repository: { workspace: { workspaceId: string } } }) =>
  (await getSessionRepositoryWorkspaceStore().get(f.repository.workspace.workspaceId))
    ?.checkpointRef;

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
      const result = await f.publish(operation);
      expect(result).toMatchObject(rejected);
      expect(writes()).toEqual([]);
      if (saved) {
        expect(f.repository.runtime.effects).toEqual([]);
        expect(await checkpointRef(f)).toBe(saved.ref);
        const calls = mocks.runCommand.mock.calls.length;
        expect(await f.publish(operation)).toEqual(result);
        expect(mocks.runCommand.mock.calls).toHaveLength(calls);
      }
    },
  );

  it("publishes ordinary guest changes with unchanged workflows and reuses immutable tree reads", async () => {
    const f = await createFixture({ [workflow]: definition });
    await f.repository.capture("ordinary code\n", "ordinary", {
      ".github/workflows/README.md": "workflow documentation\n",
    });
    expect(await f.publish("ordinary")).toMatchObject(published);
    expect(f.repository.runtime.effects).toEqual(["push", "pull_request"]);
    const trees = treeReads();
    expect(trees.length).toBeLessThanOrEqual(3);
    expect(new Set(trees).size).toBe(trees.length);
  });

  it("preserves a maintainer-published workflow in guest updates but rejects its removal", async () => {
    const f = await createFixture();
    await f.repository.capture("maintainer code\n", "maintainer", { [workflow]: definition });
    expect(await f.publish("maintainer", f.maintainer)).toMatchObject(published);
    expect(treeReads()).toEqual([]);
    await f.repository.capture("guest code\n", "guest", { [workflow]: definition });
    expect(await f.publish("guest")).toMatchObject(published);
    const effectCount = writes().length;
    const saved = await f.repository.capture("retained guest code\n", "restore-source");
    expect(await f.publish("restore-source")).toMatchObject(rejected);
    expect(writes()).toHaveLength(effectCount);
    expect(await checkpointRef(f)).toBe(saved.ref);
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
      const { git, runtime, capture } = f.repository;
      const approved = definition + "# branch-approved\n";
      if (update) {
        await capture("initial source\n", "initial", { [conflict]: approved });
        expect(await f.publish("initial", f.maintainer)).toMatchObject(published);
      }
      const upstream = {
        [workflow]: definition + "# target update\n",
        [removed]: null,
        [renamed]: null,
        [renamedTo]: definition,
        [conflict]: definition + "# target conflict\n",
      };
      const target = await capture(null, "target", upstream);
      f.targetTree(target.workspaceTree);
      const accepted = { ...upstream, ...(update ? { [conflict]: approved } : {}) };
      await capture("source after target update\n", "inherited", accepted);
      const result = await f.publish("inherited");
      expect(result, JSON.stringify(result)).toMatchObject(published);
      expect(git(["show", runtime.head + ":" + workflow])).toBe(upstream[workflow].trim());
      if (update) {
        expect(git(["show", runtime.head + ":" + conflict])).toBe(approved.trim());
        const before = writes().length;
        await capture("conflicting resolution\n", "conflict", upstream);
        expect(await f.publish("conflict")).toMatchObject(rejected);
        expect(writes()).toHaveLength(before);
      }
    },
  );

  it.each([
    "linear",
    "previous-head",
    "source-merge",
    "crisscross",
    "paged-crisscross",
    "paged-empty",
    "paged-duplicate",
    "commit-budget",
    "boundary-budget",
    "boundary-revoked",
  ] as const)("inherits target workflows only with verified ancestry (%s)", async (history) => {
    let ancestor = "";
    let left = "";
    let right = "";
    let firstSource = "";
    const ambiguous = history === "crisscross" || history === "paged-crisscross";
    const incomplete = history === "paged-empty" || history === "paged-duplicate";
    const limited = history === "commit-budget" || history === "boundary-budget";
    const revoked = history === "boundary-revoked";
    const f = await createFixture({ [workflow]: definition }, "topic", (base, tree, git) => {
      ancestor = base;
      const commit = (parents: string[], message: string) =>
        git(["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], message);
      if (history === "linear" || history === "previous-head") {
        return commit([base], "source-only feature\n");
      }
      if (revoked) {
        return commit([base, git(["rev-parse", base + "^"])], "redundant source merge\n");
      }
      if (history === "boundary-budget") {
        const parents = [base];
        for (let index = 0; index < 33; index++) {
          ancestor = commit([ancestor], "common ancestor " + index + "\n");
          parents.push(ancestor);
        }
        return commit(parents, "wide source merge\n");
      }
      if (incomplete || history === "commit-budget") {
        let head = base;
        for (let index = 0; index < (incomplete ? 101 : 1001); index++) {
          head = commit([head], "source-only feature " + index + "\n");
          if (index === 0) {
            firstSource = head;
          }
        }
        return head;
      }
      left = commit([base], "left branch\n");
      right = commit([base], "right branch\n");
      let head = left;
      if (history === "paged-crisscross") {
        for (let index = 0; index < 100; index++) {
          head = commit([head], "source-only feature " + index + "\n");
        }
      }
      return commit([head, right], "source merge\n");
    });
    const { git, runtime, baseCommit, capture } = f.repository;
    if (history === "previous-head") {
      expect(await f.publish("first-source")).toMatchObject(published);
    }
    const comparisonHead = runtime.head ?? baseCommit;
    const updated = definition + "# upstream-only change\n";
    const target = await capture(null, "upstream", { [workflow]: updated }, false);
    if (ambiguous) {
      runtime.baseHead = git(
        ["commit-tree", target.workspaceTree, "-p", left, "-p", right],
        "target merge\n",
      );
      runtime.baseHeadTree = target.workspaceTree;
    } else {
      f.targetTree(target.workspaceTree, ancestor, "upstream workflow update\n");
    }
    runtime.mergeBase = ambiguous ? left : ancestor;
    runtime.mergeBaseTree = git(["rev-parse", runtime.mergeBase + "^{tree}"]);
    const sourcePages: number[] = [];
    const sourceHeads: string[] = [];
    let boundaryReads = 0;
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, options) => {
      const endpoint = args.find((arg: string) => arg.startsWith("repos/")) ?? "";
      if (endpoint.includes("/compare/")) {
        const [source, head] = endpoint.split("/compare/")[1]!.split("?")[0]!.split("...");
        if (endpoint.includes("per_page=100")) {
          const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
          sourcePages.push(page);
          sourceHeads.push(head!);
          if (page === 2 && incomplete) {
            return json({
              total_commits: 101,
              commits:
                history === "paged-empty"
                  ? []
                  : [{ sha: firstSource, parents: [{ sha: ancestor }] }],
            });
          }
          return transport(args, options);
        }
        if (source !== baseCommit && source !== comparisonHead) {
          boundaryReads++;
          if (revoked) {
            await f.revoke();
          }
        }
        return json({
          sha:
            (source === baseCommit || source === comparisonHead) && head === runtime.baseHead
              ? runtime.mergeBase
              : git(["merge-base", source!, head!]),
        });
      }
      return transport(args, options);
    });
    await capture("feature checkpoint\n", "refreshed", { [workflow]: updated });
    const writesBefore = writes().length;
    const result = await f.publish("refreshed");
    const expected = revoked
      ? identityChanged
      : incomplete
        ? { status: "failed", code: "unavailable" }
        : ambiguous || limited
          ? rejected
          : published;
    expect(result, JSON.stringify(result)).toMatchObject(expected);
    const paged = history.startsWith("paged-");
    expect(sourcePages).toEqual(history === "previous-head" ? [1, 1] : paged ? [1, 2] : [1]);
    expect(sourceHeads).toEqual(
      history === "previous-head"
        ? [comparisonHead, baseCommit]
        : sourcePages.map(() => comparisonHead),
    );
    if (ambiguous || incomplete || limited || revoked) {
      expect(writes()).toHaveLength(writesBefore);
    } else {
      expect(git(["show", runtime.head + ":" + workflow])).toBe(updated.trim());
      expect(git(["show", runtime.head + ":counter.txt"])).toBe("feature checkpoint");
    }
    if (history === "boundary-budget") {
      expect(boundaryReads).toBe(0);
    }
    if (revoked) {
      expect(boundaryReads).toBe(1);
    }
  });

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
      const candidateCommit = f.commitTree(accepted.workspaceTree);
      const parent =
        failure === "diverged"
          ? git(["rev-parse", baseCommit + "^"])
          : failure === "stale"
            ? candidateCommit
            : baseCommit;
      f.targetTree(target.workspaceTree, parent, "authenticated target\n");
      runtime.mergeBase = git(["merge-base", baseCommit, runtime.baseHead]);
      runtime.mergeBaseTree = git(["rev-parse", runtime.mergeBase + "^{tree}"]);
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (args, options) => {
        if (failure === "foreign") {
          const endpoint = args.find((arg: string) => arg.startsWith("repos/")) ?? "";
          if (endpoint === "repos/owner/repository") {
            return json({
              node_id: "repository-node",
              fork: true,
              default_branch: "main",
              parent: { name: "repository", owner: { login: "upstream" }, default_branch: "main" },
            });
          }
          if (endpoint === "repos/owner/repository/git/ref/heads/main") {
            return json({ ref: "refs/heads/main", object: { sha: candidateCommit } });
          }
          if (endpoint.endsWith("/git/commits/" + candidateCommit)) {
            return json({ sha: candidateCommit, tree: { sha: accepted.workspaceTree } });
          }
          if (endpoint.includes("/compare/")) {
            const [source, head] = endpoint.split("/compare/")[1]!.split("?")[0]!.split("...");
            return json({ sha: git(["merge-base", source!, head!]) });
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
      const result = await f.publish(failure);
      expect(result).toMatchObject(failure.endsWith("revoked") ? identityChanged : rejected);
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
    const accepted = await f.coordinator.requestForSessionV2(
      f.request("deferred-workflow", f.guest),
    );
    expect(accepted.status).toBe("requested");
    const original = f.readRequester(accepted.requestId);
    expect(original?.scopes).toEqual(guestScopes);
    await setCanonicalUserProfileRole(f.guestProfile, "maintainer");
    invalidateOperatorRolePolicy(f.guestProfile);
    await f.placements.releaseTurn(claim);
    f.guestSource.release();

    const restarted = f.restart();
    await restarted.resumeSessionRequests();
    expect(await restarted.readAsync(accepted.requestId)).toMatchObject(rejected);
    expect(f.readRequester(accepted.requestId)).toEqual(original);
    expect(f.externalWrites).toEqual([]);
    expect(await checkpointRef({ repository: f.repository })).toBe(saved.ref);
  });

  it.each(["truncated", "different-tree"] as const)(
    "refuses a %s workflow tree observation before upload",
    async (failure) => {
      const f = await createFixture();
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (args, options) => {
        if (args.some((arg: string) => arg.includes("/git/trees/"))) {
          return json({
            sha: failure === "different-tree" ? "a".repeat(40) : f.repository.baseTree,
            tree: [],
            truncated: failure === "truncated",
          });
        }
        return await transport(args, options);
      });
      expect(await f.publish(failure)).toMatchObject({ status: "failed", code: "unavailable" });
      expect(writes()).toEqual([]);
    },
  );

  it("rechecks workflow authority after a blob response before writing the tree or branch", async () => {
    const f = await createFixture();
    await f.repository.capture("accepted code\n", "authority-change", { [workflow]: definition });
    observeRepositoryCommands(async (args) => {
      if (args.some((arg: string) => arg.endsWith("/git/blobs"))) {
        await setCanonicalUserProfileRole(f.maintainerProfile, "revoked");
        invalidateOperatorRolePolicy(f.maintainerProfile);
      }
    });
    expect(await f.publish("authority-change", f.maintainer)).toMatchObject(identityChanged);
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

    expect(await f.publish("publisher-at-ref", f.maintainer)).toMatchObject({
      status: "requested",
    });
    expect(publisherRevoked).toBe(true);
    expect(f.maintainer.assertCurrent).not.toThrow();
    expect(f.repository.runtime.uploaded.size).toBeGreaterThan(0);
    expect(f.repository.casRequests).toEqual([]);
    expect(f.repository.runtime.effects).toEqual([]);
  });
});

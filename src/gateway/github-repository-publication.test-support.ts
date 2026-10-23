import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Mock } from "vitest";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  persistPublicationTestSession,
  root,
} from "./github-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { SessionRepositoryCheckpointPayload } from "./worker-environments/session-repository-checkpoints.js";

const mocks = githubPublicationTestMocks();
export const repositoryPublicationTestUrl = "https://github.com/owner/repository/pull/1";
export function observeRepositoryCommands(observe: (args: string[]) => void | Promise<void>) {
  const transport = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (args: string[], options) => {
    const result = await transport(args, options);
    await observe(args);
    return result;
  });
}
const jsonResult = (value: unknown, code = 0) => commandResult(JSON.stringify(value), code);
type PullRequest = Record<"url" | "state" | "body" | "headSha" | "headRef" | "baseRef", string> & {
  userId: number;
};

export async function createRepositoryPublicationFixture(
  checkpoint: Mock,
  requestedRef?: string | { kind: "commit" },
  session = { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
  baseFiles: Record<string, string> = {},
) {
  // Only the mock GitHub service accesses this object store. The broker still
  // rejects every Git command and receives only the normalized checkpoint.
  const remote = await fs.mkdtemp(path.join(root, "fixture-github-"));
  const git = (args: string[], input?: string | Buffer) =>
    execFileSync("git", args, {
      cwd: remote,
      input,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_CONFIG_COUNT: "0",
        GIT_AUTHOR_NAME: "Publication Fixture",
        GIT_AUTHOR_EMAIL: "publication@example.test",
        GIT_COMMITTER_NAME: "Publication Fixture",
        GIT_COMMITTER_EMAIL: "publication@example.test",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    }).trim();
  git(["init", "--bare", "--quiet", "--initial-branch=main", "--object-format=sha1"]);
  const writeTree = (
    base: string,
    entries: Array<{ path: string; mode: string; sha: string | null }>,
  ) => {
    git(["read-tree", base]);
    git(
      ["update-index", "-z", "--index-info"],
      entries
        .map(
          (entry) =>
            `${entry.sha === null ? "0" : entry.mode} ${entry.sha ?? "0".repeat(40)}\t${entry.path}\0`,
        )
        .join(""),
    );
    return git(["write-tree"]);
  };
  const emptyTree = git(["mktree"], "");
  const baseTree = writeTree(
    emptyTree,
    Object.entries(baseFiles).map(([file, content]) => ({
      path: file,
      mode: "100644",
      sha: git(["hash-object", "-w", "--stdin"], content),
    })),
  );
  const baseParent = Object.keys(baseFiles).length
    ? git(["commit-tree", emptyTree], "fixture prior base\n")
    : undefined;
  const baseCommit = git(
    ["commit-tree", baseTree, ...(baseParent ? ["-p", baseParent] : [])],
    "fixture base\n",
  );
  const sourceRef = typeof requestedRef === "string" ? requestedRef : requestedRef && baseCommit;
  const store = getSessionRepositoryWorkspaceStore();
  let workspace = await store.create({
    agentId: "main",
    sessionKey: session.sessionKey,
    url: "https://github.com/owner/repository.git",
    requestedRef: sourceRef,
    assertCurrent: () => {},
  });
  workspace = await store.bindBase({
    workspaceId: workspace.workspaceId,
    expectedRevision: workspace.revision,
    baseCommit,
    baseManifestHash: "sha256:" + "1".repeat(64),
    assertCurrent: () => {},
  });
  const original = mocks.loadSession.getMockImplementation()!;
  mocks.loadSession.mockImplementation((key: string) => {
    const loaded = original(key);
    return key === session.sessionKey
      ? {
          ...loaded,
          entry: { sessionId: session.sessionId, repositoryWorkspaceId: workspace.workspaceId },
        }
      : loaded;
  });
  const sessionOwner = await persistPublicationTestSession(session.sessionKey);
  const payloads = new Map<string, { publicationStagingRoot: string; publicationDigest: string }>();
  const capture = async (
    content: string | null,
    suffix: string,
    changes: Record<string, string | null> = {},
  ) => {
    const bytes = Buffer.from(content ?? "");
    const sha = git(["hash-object", "-w", "--stdin"], bytes);
    const publicationStagingRoot = path.join(root, workspace.workspaceId, "checkpoint-" + suffix);
    await fs.mkdir(path.join(publicationStagingRoot, "blobs"), { recursive: true });
    const entries = await Promise.all(
      Object.entries({
        ...(content === null ? {} : { "counter.txt": content }),
        ...changes,
      }).map(async ([file, value]) => {
        const object = value === null ? null : git(["hash-object", "-w", "--stdin"], value);
        if (object) {
          await fs.writeFile(path.join(publicationStagingRoot, "blobs", object), value!);
        }
        return { path: file, mode: "100644", sha: object };
      }),
    );
    const workspaceTree = writeTree(baseTree, entries);
    const raw = JSON.stringify({ version: 1, baseCommit, baseTree, workspaceTree, entries });
    await fs.writeFile(path.join(publicationStagingRoot, "snapshot.json"), raw);
    const publicationDigest = "sha256:" + createHash("sha256").update(raw).digest("hex");
    const ref = "refs/openclaw/worker-results/" + suffix;
    payloads.set(ref, { publicationStagingRoot, publicationDigest });
    workspace = await store.acceptCheckpoint({
      workspaceId: workspace.workspaceId,
      expectedRevision: workspace.revision,
      checkpointRef: ref,
      manifestHash: "sha256:" + createHash("sha256").update(suffix).digest("hex"),
      assertCurrent: () => {},
    });
    return { ref, sha, workspaceTree };
  };
  const first = await capture("accepted first\n", "first");
  checkpoint
    .mockReset()
    .mockImplementation(
      async (
        request: { workspaceId: string; checkpointRef: string },
        use: (payload: Partial<SessionRepositoryCheckpointPayload>) => Promise<unknown>,
      ) => {
        expect(request).toMatchObject({
          workspaceId: workspace.workspaceId,
        });
        const payload = payloads.get(request.checkpointRef);
        if (!payload) {
          throw new Error("Unknown checkpoint ref");
        }
        return await use(payload);
      },
    );
  const runtime = {
    head: null as string | null,
    pr: null as PullRequest | null,
    accountId: 42,
    interruptPush: false,
    closePullRequest: false,
    changeHeadDuringPush: false,
    commonHistory: true,
    baseHead: baseCommit,
    baseHeadTree: baseTree,
    mergeBase: baseCommit,
    mergeBaseTree: baseTree,
    afterPush: () => {},
    afterHeadObservation: () => {},
    uploaded: new Map<string, Buffer>(),
    effects: [] as string[],
  };
  const commits = new Map<
    string,
    { sha: string; tree: { sha: string }; parents: Array<{ sha: string }>; message: string }
  >();
  const casRequests: Array<{ beforeOid: string; afterOid: string; force: boolean }> = [];
  mocks.runCommand.mockImplementation(async (args: string[], options: { input?: string } = {}) => {
    // The whole broker path must work with no Git repository on the Gateway.
    if (args[0] !== "gh") {
      throw new Error("Publication attempted a Gateway Git command");
    }
    const endpoint =
      args.find((arg) => arg.startsWith("repos/")) ?? (args.includes("graphql") ? "graphql" : "");
    const body = options.input ? JSON.parse(options.input) : undefined;
    if (endpoint === "repos/owner/repository") {
      return jsonResult({ fork: false, default_branch: "main", node_id: "repository-node" });
    }
    if (endpoint.includes("/git/commits/")) {
      const sha = endpoint.split("/").at(-1)!;
      const known = [
        [baseCommit, baseTree],
        [runtime.baseHead, runtime.baseHeadTree],
        [runtime.mergeBase, runtime.mergeBaseTree],
      ].find(([commit]) => sha === commit);
      return jsonResult(known ? { sha, tree: { sha: known[1] } } : commits.get(sha));
    }
    if (endpoint.includes("/git/matching-refs/")) {
      const managed =
        decodeURIComponent(endpoint.split("/git/matching-refs/heads/")[1]!) === workspace.branch;
      const head = managed ? runtime.head : requestedRef === "topic" ? baseCommit : null;
      const branch = managed ? workspace.branch : "topic";
      const result = jsonResult(
        head ? [{ ref: "refs/heads/" + branch, object: { sha: head } }] : [],
      );
      if (managed) {
        runtime.afterHeadObservation();
      }
      return result;
    }
    if (endpoint.includes("/git/ref/heads/")) {
      return jsonResult({
        ref: "refs/heads/" + decodeURIComponent(endpoint.split("/git/ref/heads/")[1]!),
        object: { sha: runtime.baseHead },
      });
    }
    if (endpoint.includes("/compare/")) {
      const source = endpoint.split("/compare/")[1]!.split("...")[0]!;
      expect(endpoint).toContain("..." + runtime.baseHead);
      if (source !== baseCommit) {
        return jsonResult({ sha: git(["merge-base", source, runtime.baseHead]) });
      }
      return jsonResult({ sha: runtime.commonHistory ? runtime.mergeBase : null });
    }
    if (endpoint.endsWith("/git/blobs")) {
      expect(body.encoding).toBe("base64");
      const bytes = Buffer.from(body.content, "base64");
      const sha = git(["hash-object", "-w", "--stdin"], bytes);
      runtime.uploaded.set(sha, bytes);
      return jsonResult({ sha });
    }
    if (endpoint.includes("/git/trees/")) {
      const sha = endpoint.split("/").at(-1)!;
      const tree = git(["ls-tree", "-z", sha])
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const separator = record.indexOf("\t");
          const [mode, type, object] = record.slice(0, separator).split(" ");
          return { path: record.slice(separator + 1), mode, type, sha: object };
        });
      return jsonResult({ sha, tree, truncated: false });
    }
    if (endpoint.endsWith("/git/trees")) {
      expect(body.base_tree).toBe(baseTree);
      const sha = writeTree(baseTree, body.tree);
      return jsonResult({ sha });
    }
    if (endpoint.endsWith("/git/commits")) {
      expect(body.parents).toHaveLength(1);
      expect(body.parents[0] === baseCommit || commits.has(body.parents[0])).toBe(true);
      expect(body.message).toContain("OpenClaw-Publication:");
      const sha = git(["commit-tree", body.tree, "-p", body.parents[0]], body.message);
      const commit = {
        sha,
        tree: { sha: body.tree },
        parents: body.parents.map((parentSha: string) => ({ sha: parentSha })),
        message: body.message,
      };
      commits.set(sha, commit);
      return jsonResult(commit);
    }
    if (endpoint === "graphql") {
      const update = body.variables.input.refUpdates[0];
      casRequests.push(update);
      expect(update.force).toBe(false);
      expect(body.variables.input.repositoryId).toBe("repository-node");
      expect(update.name).toBe("refs/heads/" + workspace.branch);
      if (runtime.changeHeadDuringPush) {
        runtime.head = "f".repeat(40);
      }
      if (update.beforeOid !== (runtime.head ?? "0".repeat(40))) {
        return jsonResult({ errors: [{ message: "Ref lease failed" }] }, 1);
      }
      runtime.head = update.afterOid;
      if (runtime.pr) {
        runtime.pr.headSha = runtime.head!;
      }
      runtime.effects.push("push");
      runtime.afterPush();
      if (runtime.interruptPush) {
        runtime.interruptPush = false;
        throw new Error("Synthetic lost ref response");
      }
      return jsonResult({
        data: { updateRefs: { clientMutationId: body.variables.input.clientMutationId } },
      });
    }
    if (endpoint.endsWith("/pulls") && args.includes("state=all")) {
      return jsonResult(runtime.pr ? [runtime.pr] : []);
    }
    if (endpoint.endsWith("/pulls") && args.includes("POST")) {
      runtime.effects.push("pull_request");
      runtime.pr = {
        url: repositoryPublicationTestUrl,
        userId: runtime.accountId,
        state: runtime.closePullRequest ? "closed" : "open",
        body: body.body,
        headSha: runtime.head!,
        headRef: workspace.branch,
        baseRef: body.base,
      };
      return jsonResult(
        { html_url: repositoryPublicationTestUrl },
        runtime.closePullRequest ? 1 : 0,
      );
    }
    throw new Error("Unexpected GitHub endpoint " + endpoint);
  });
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  const coordinator = createTestGitHubPublicationCoordinator({ placements });
  return {
    git,
    baseCommit,
    baseTree,
    runtime,
    capture,
    first,
    casRequests,
    workspace,
    placements,
    closeSession: async (kind: "archive" | "reset" | "move") => {
      if (kind === "reset") {
        await sessionOwner.reset(placements);
      } else {
        await patchSessionEntryCore(
          {
            agentId: "main",
            sessionKey: session.sessionKey,
            storePath: sessionOwner.storePath,
          },
          kind === "archive"
            ? () => ({ archivedAt: Date.now() })
            : (current) => ({ ...current, repositoryWorkspaceId: undefined }),
          { replaceEntry: kind === "move" },
        );
      }
    },
    coordinator,
    publish(
      idempotencyKey: string,
      options: Partial<Parameters<typeof coordinator.requestForSessionV2>[0]> = {},
    ) {
      return coordinator.requestForSessionV2({
        agentId: "main",
        sessionKey: session.sessionKey,
        idempotencyKey,
        ...options,
      });
    },
  };
}

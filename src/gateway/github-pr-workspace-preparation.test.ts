// Install synthetic GitHub I/O before the registered publication owners load.
// oxfmt-ignore
import {
  publicationCheckpoint as checkpoint,
  withPublicationToolTransport,
} from "./github-publication-actions.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isNodeError } from "@openclaw/fs-safe/path";
import { describe, expect, it, vi } from "vitest";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import * as sandboxEngine from "../agents/sandbox/docker.js";
import { createSandboxFsBridge } from "../agents/sandbox/fs-bridge.js";
import {
  bindLocalSandboxWorkspace,
  prepareLocalSandboxWorkspace,
} from "../agents/sandbox/local-workspace.js";
import { updateRegistry } from "../agents/sandbox/registry.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import { ensureEmptyWorktreeSource } from "../agents/worktrees/empty-source.js";
import { deleteRegistryWorktree, insertRegistryWorktree } from "../agents/worktrees/registry.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  linkCanonicalUserProfileEmail,
  syncCanonicalGitHubIdentity,
} from "../state/user-profile-writes.js";
import { createRequesterPublicationFixture } from "./github-publication-requester.test-support.js";
import {
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createContext as createRequestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "./worker-environments/local-workspace-projection.js";
import * as workspaceStore from "./worker-environments/local-workspace-store.js";
import { isLocalWorkspaceBaseRefreshRef } from "./worker-environments/workspace-result-inventory.js";

const mocks = githubPublicationTestMocks();

async function fixture(
  options: { fork?: boolean; empty?: boolean; conflict?: boolean; priorPublication?: boolean } = {},
) {
  const original = { ...mocks.findWorktree("session", "unused"), id: randomUUID() };
  mocks.findWorktree.mockImplementation((_kind: string, ownerId: string) => ({
    ...original,
    ownerId,
  }));
  const f = await createRequesterPublicationFixture(checkpoint, "local");
  const local = f.local!;
  const scope = { agentId: "main", sessionKey: f.session.sessionKey };
  const readSession = () => loadSessionEntryReadOnly(scope)!;
  if (options.priorPublication) {
    const previous = await f.coordinator.requestForSessionV2(f.request("earlier-pr", f.guest));
    expect(previous.status).toBe("published");
    f.externalWrites.length = 0;
  }
  await syncCanonicalGitHubIdentity({
    identity: { accountId: 101, login: "contributor" },
    authenticationAlias: { kind: "email", email: "publication-guest@example.test" },
  });
  const upstream = path.join(path.dirname(local.cwd), "upstream");
  await local.git("clone", "--no-local", "--branch", "main", local.cwd, upstream);
  const commonAncestor = await local.git("-C", upstream, "rev-parse", "HEAD");
  await local.git("-C", upstream, "checkout", "-b", "topic/existing");
  await fs.writeFile(path.join(upstream, "pr.txt"), "original PR contents\n");
  if (options.conflict) {
    await fs.writeFile(path.join(upstream, "artifact.txt"), "original PR change\n");
  }
  await local.git("-C", upstream, "add", "-A");
  await local.git("-C", upstream, "commit", "-m", "Existing PR work");
  const headCommit = await local.git("-C", upstream, "rev-parse", "HEAD");
  await local.git("-C", upstream, "checkout", "main");
  await fs.writeFile(path.join(upstream, "newer-base.txt"), "base advanced after PR\n");
  await local.git("-C", upstream, "add", "newer-base.txt");
  await local.git("-C", upstream, "commit", "-m", "Newer base work");
  const baseCommit = await local.git("-C", upstream, "rev-parse", "HEAD");
  // The publication harness starts with staged work. A fresh selected-project
  // fixture instead starts at the real, clean project base; prior publications
  // retain their existing work and must be refused by initial preparation.
  if (!options.empty) {
    await local.git("fetch", "--no-write-fetch-head", upstream, "main");
    await local.git("update-ref", "refs/heads/main", baseCommit);
    if (!options.priorPublication) {
      await local.git("reset", "--hard", baseCommit);
    }
  }
  let cwd = local.cwd;
  let emptySource: string | undefined;
  if (options.empty) {
    emptySource = await ensureEmptyWorktreeSource({
      env: process.env,
      ownerId: f.session.sessionKey,
      commitGuard: () => {},
    });
    cwd = path.join(path.dirname(local.cwd), "empty-worktree");
    const previous = mocks.findWorktree("session", f.session.sessionKey);
    await local.git("-C", emptySource, "worktree", "add", "-b", previous.branch, cwd);
    const worktree = { ...previous, path: cwd, repoRoot: emptySource };
    await deleteRegistryWorktree(process.env, previous.id);
    await insertRegistryWorktree(process.env, {
      ...worktree,
      name: "empty PR preparation",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    mocks.findWorktree.mockReturnValue(worktree);
    mocks.findWorktreeById.mockReturnValue(worktree);
    await upsertSessionEntryCore(scope, {
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: emptySource },
      spawnedCwd: cwd,
      sessionRoot: cwd,
    });
  }
  const git = (...args: string[]) => local.git("-C", cwd, ...args);
  const baseRepo = {
    id: 10,
    full_name: "openclaw/openclaw",
    private: false,
    archived: false,
    owner: { type: "Organization" },
    permissions: { push: true },
  };
  const headRepo = options.fork
    ? {
        ...baseRepo,
        id: 20,
        full_name: "contributor/openclaw",
        owner: { type: "User" },
        permissions: { push: false },
      }
    : baseRepo;
  const pr = {
    number: 7,
    html_url: "https://github.com/openclaw/openclaw/pull/7",
    user: { id: 101, login: "contributor" },
    state: "open",
    draft: false,
    merged: false,
    maintainer_can_modify: true,
    base: { repo: baseRepo, ref: "main", sha: baseCommit },
    head: { repo: headRepo, ref: "topic/existing", sha: headCommit },
  };
  const branch = { name: pr.head.ref, commit: { sha: pr.head.sha }, protected: false };
  const { runCommandBuffered } =
    await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  const transport = mocks.runCommand.getMockImplementation()!;
  const writes: string[][] = [];
  mocks.runCommand.mockImplementation(
    async (
      argv: string[],
      commandOptions?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
    ) => {
      if (argv.includes("push") || (argv[0] === "gh" && !argv.includes("GET"))) {
        writes.push(argv);
        throw new Error("PR preparation attempted a GitHub write");
      }
      if (argv[0] === "gh") {
        const endpoint = argv.at(-1)!;
        const value =
          endpoint === "repos/openclaw/openclaw"
            ? baseRepo
            : endpoint === "repos/contributor/openclaw"
              ? headRepo
              : endpoint === `repos/openclaw/openclaw/pulls/${pr.number}`
                ? pr
                : endpoint.includes("/branches/")
                  ? branch
                  : undefined;
        if (!value) {
          throw new Error(`Unexpected GitHub read: ${endpoint}`);
        }
        return commandResult(JSON.stringify(value));
      }
      if (argv.includes("fetch")) {
        return await runCommandBuffered(
          argv.map((arg) =>
            /^https:\/\/github\.com\/(openclaw|contributor)\/openclaw\.git$/u.test(arg)
              ? pathToFileURL(upstream).href
              : arg,
          ),
          {
            ...commandOptions,
            cwd: commandOptions?.cwd ?? cwd,
            timeoutMs: 10_000,
            env: {
              ...process.env,
              ...commandOptions?.env,
              GIT_CONFIG_GLOBAL: os.devNull,
              GIT_CONFIG_SYSTEM: os.devNull,
              GH_TOKEN: undefined,
              GITHUB_TOKEN: undefined,
              GH_CONFIG_DIR: undefined,
            },
          },
        );
      }
      return await transport(argv, commandOptions);
    },
  );
  using owner = await resolveLocalWorkspaceOwner({ ...scope, cfg: f.config });
  if (!owner) {
    throw new Error("Fixture managed workspace unavailable");
  }
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const sandbox = createSandboxTestContext({
    overrides: {
      sessionKey: f.session.sessionKey,
      workspaceDir: projection,
      containerWorkdir: projection,
      workspaceSource: "managed-worktree",
      backend: {
        id: "docker",
        runtimeId: "fixture",
        runtimeLabel: "fixture",
        workdir: projection,
        buildExecSpec: async () => {
          throw new Error("Fixture does not expose arbitrary exec");
        },
        runShellCommand: async ({ script, args, stdin, signal }) => {
          const result = await runCommandBuffered(
            ["sh", "-c", script, "sandbox-fixture", ...(args ?? [])],
            {
              cwd: projection,
              input: stdin,
              signal,
              timeoutMs: 10_000,
              env: {
                ...process.env,
                GIT_CONFIG_GLOBAL: os.devNull,
                GIT_CONFIG_SYSTEM: os.devNull,
                GIT_AUTHOR_NAME: "Guest",
                GIT_AUTHOR_EMAIL: "guest@example.test",
                GIT_COMMITTER_NAME: "Guest",
                GIT_COMMITTER_EMAIL: "guest@example.test",
                GH_TOKEN: undefined,
                GITHUB_TOKEN: undefined,
                GH_CONFIG_DIR: undefined,
              },
            },
          );
          if (result.code === null) {
            throw new Error("Fixture sandbox command did not exit");
          }
          return { code: result.code, stdout: result.stdout, stderr: result.stderr };
        },
      },
    },
  });
  const guestGit = async (...args: string[]) => {
    const result = await sandbox.backend!.runShellCommand({ script: 'git "$@"', args });
    if (result.code !== 0) {
      throw new Error(result.stderr.toString());
    }
    return result.stdout.toString().trim();
  };
  const invoke = async (
    args: Record<string, unknown> = {},
    prepared: SandboxContext | null = sandbox,
  ) => {
    const callGateway: InProcessGatewayCaller = async <T>(
      method: string,
      params: Record<string, unknown>,
    ) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: randomUUID(), method, params },
        client: f.guestSource.client,
        context: Object.assign(createRequestContext(), f.guestSource.context, {
          githubPublicationService: f.coordinator,
          workerSessionPlacementService: f.placements,
        }),
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, result, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error.message);
      }
      return result as T;
    };
    const result = await withGatewayToolCallerIdentity(scope, () =>
      withPublicationToolTransport(callGateway, () =>
        createGitHubPublishTool({ sandbox: prepared }).execute(
          "prepare",
          Object.fromEntries(
            Object.entries({
              action: "prepare_pr",
              pullRequestUrl: pr.html_url,
              ...args,
            }).filter(([, value]) => value !== undefined),
          ),
        ),
      ),
    );
    return result.details;
  };
  const advanceHead = async (files: Record<string, string>) => {
    await local.git("-C", upstream, "checkout", "topic/existing");
    for (const [file, contents] of Object.entries(files)) {
      await fs.writeFile(path.join(upstream, file), contents);
    }
    await local.git("-C", upstream, "add", "-A");
    await local.git("-C", upstream, "commit", "-m", "Advance existing PR");
    pr.head.sha = await local.git("-C", upstream, "rev-parse", "HEAD");
    branch.commit.sha = pr.head.sha;
    return pr.head.sha;
  };
  return {
    ...f,
    cwd,
    git,
    guestGit,
    projection,
    sandbox,
    emptySource,
    upstream,
    pr,
    branch,
    headCommit,
    commonAncestor,
    readSession,
    invoke,
    advanceHead,
    writes,
  };
}

describe("existing PR preparation through the registered agent action", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each([false, true])(
    "installs the exact PR head from a clean newer project base and preserves later work (fork=%s)",
    async (fork) => {
      const f = await fixture({ fork });
      const before = f.readSession();
      const originalHead = await f.git("rev-parse", "HEAD");
      const originalGuestHead = await f.guestGit("rev-parse", "HEAD");
      const guestBranch = await f.guestGit("symbolic-ref", "HEAD");
      expect(originalHead).toBe(f.pr.base.sha);
      expect(await f.git("status", "--porcelain")).toBe("");
      expect(await fs.readFile(path.join(f.projection, "newer-base.txt"), "utf8")).toBe(
        "base advanced after PR\n",
      );
      await expect(f.invoke({}, null)).rejects.toThrow("sandboxed agent");
      await expect(f.invoke({}, { ...f.sandbox, workspaceAccess: "ro" })).rejects.toThrow(
        "read-only",
      );
      expect(f.readSession().worktree?.githubPullRequest).toBeUndefined();
      expect(await f.invoke()).toMatchObject({
        status: "prepared",
        url: f.pr.html_url,
        headCommit: f.headCommit,
        headChanged: false,
        review: { mode: "local", base: f.commonAncestor },
      });
      expect(f.readSession()).toMatchObject({
        sessionId: before.sessionId,
        worktree: {
          ...before.worktree,
          githubPullRequest: {
            url: f.pr.html_url,
            host: "github.com",
            number: 7,
            base: {
              repository: "openclaw/openclaw",
              repositoryId: 10,
              branch: "main",
              commit: f.pr.base.sha,
            },
            head: {
              repository: fork ? "contributor/openclaw" : "openclaw/openclaw",
              repositoryId: fork ? 20 : 10,
              branch: "topic/existing",
              commit: f.headCommit,
            },
            preparedHeadCommit: f.headCommit,
          },
        },
      });
      const prTree = await f.local!.git("-C", f.upstream, "rev-parse", `${f.headCommit}^{tree}`);
      expect(await f.git("rev-parse", "HEAD")).toBe(f.headCommit);
      expect(await f.git("write-tree")).toBe(prTree);
      expect(await f.git("diff", "--name-only", f.headCommit)).toBe("");
      expect(await f.git("status", "--porcelain")).toBe("");
      expect(await f.guestGit("write-tree")).toBe(prTree);
      expect(await f.guestGit("diff", "--name-only")).toBe("");
      for (const directory of [f.cwd, f.projection]) {
        expect(await fs.readFile(path.join(directory, "pr.txt"), "utf8")).toBe(
          "original PR contents\n",
        );
        await expect(fs.stat(path.join(directory, "newer-base.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(await f.git("rev-parse", "ORIG_HEAD")).toBe(originalHead);
      expect(await f.guestGit("rev-parse", "HEAD")).toBe(originalGuestHead);
      expect(await f.guestGit("symbolic-ref", "HEAD")).toBe(guestBranch);
      expect(await f.guestGit("rev-parse", "refs/openclaw/review-base")).toBe(f.commonAncestor);
      expect(
        (await f.guestGit("diff", "--cached", "--name-only", f.commonAncestor)).split("\n"),
      ).toContain("pr.txt");

      // Work produced after this PR is accepted belongs to its continuation.
      await fs.writeFile(path.join(f.projection, "guest-commit.txt"), "unpublished guest commit\n");
      await f.guestGit("add", "guest-commit.txt");
      await f.guestGit("commit", "-m", "Guest work after PR preparation");
      const continuedGuestHead = await f.guestGit("rev-parse", "HEAD");
      await fs.writeFile(path.join(f.projection, "artifact.txt"), "guest saved dirty work\n");
      await fs.writeFile(path.join(f.projection, "untracked.txt"), "guest untracked work\n");
      const association = f.readSession().worktree?.githubPullRequest;
      const workspaceState = async () => ({
        hostHead: await f.git("rev-parse", "HEAD"),
        hostIndex: await f.git("write-tree"),
        hostStatus: await f.git("status", "--porcelain"),
        guestHead: await f.guestGit("rev-parse", "HEAD"),
        guestIndex: await f.guestGit("write-tree"),
        guestStatus: await f.guestGit("status", "--porcelain"),
      });
      const beforeRepeat = await workspaceState();
      await closeOpenClawAgentDatabasesAsync();
      expect(f.readSession().worktree?.githubPullRequest).toEqual(association);
      expect(await f.invoke()).toMatchObject({
        status: "prepared",
        headCommit: f.headCommit,
        headChanged: false,
      });
      for (const [file, contents] of Object.entries({
        "guest-commit.txt": "unpublished guest commit\n",
        "artifact.txt": "guest saved dirty work\n",
        "untracked.txt": "guest untracked work\n",
      })) {
        expect(await fs.readFile(path.join(f.projection, file), "utf8")).toBe(contents);
      }
      expect(await workspaceState()).toEqual(beforeRepeat);
      expect(f.readSession().worktree?.githubPullRequest).toEqual(association);
      expect(await fs.readFile(path.join(f.cwd, "artifact.txt"), "utf8")).toBe("base\n");
      for (const file of ["guest-commit.txt", "untracked.txt"]) {
        await expect(fs.stat(path.join(f.cwd, file))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await f.guestGit("rev-parse", "HEAD")).toBe(continuedGuestHead);
      expect(await f.guestGit("symbolic-ref", "HEAD")).toBe(guestBranch);
      await f.advanceHead({ "newer-pr.txt": "newer remote PR work\n" });
      await expect(f.invoke()).rejects.toThrow(/newer|advanced|changed/u);
      expect(await workspaceState()).toEqual(beforeRepeat);
      expect(f.readSession().worktree?.githubPullRequest).toEqual(association);
      expect(await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8")).toBe(
        "guest saved dirty work\n",
      );
      expect(await fs.readFile(path.join(f.projection, "untracked.txt"), "utf8")).toBe(
        "guest untracked work\n",
      );
      for (const directory of [f.cwd, f.projection]) {
        await expect(fs.stat(path.join(directory, "newer-pr.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(f.invoke({ action: "publish", pullRequestUrl: undefined })).rejects.toThrow(
        "original branch",
      );
      await expect(f.invoke({ action: "refresh_base", pullRequestUrl: undefined })).rejects.toThrow(
        "prepare_pr",
      );
      await expect(
        f.invoke({
          action: "request_review",
          pullRequestUrl: undefined,
          requestId: randomUUID(),
          expectedHeadCommit: f.headCommit,
        }),
      ).rejects.toThrow("without a publication requestId");
      f.pr.number = 8;
      f.pr.html_url = "https://github.com/openclaw/openclaw/pull/8";
      await expect(f.invoke()).rejects.toThrow("already continues another PR");
      expect(f.readSession().worktree?.githubPullRequest).toEqual(association);
      expect(await fs.readFile(path.join(f.projection, "untracked.txt"), "utf8")).toBe(
        "guest untracked work\n",
      );
      expect(f.writes).toEqual([]);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it.each([false, true])(
    "uses the actual empty source only when no earlier work needs preserving (earlier notes=%s)",
    async (earlierNotes) => {
      const f = await fixture({ empty: true, fork: true });
      const before = f.readSession();
      const emptyHead = await f.local!.git("-C", f.emptySource!, "rev-parse", "HEAD");
      const guestHead = await f.guestGit("rev-parse", "HEAD");
      const guestBranch = await f.guestGit("symbolic-ref", "HEAD");
      if (earlierNotes) {
        await fs.writeFile(path.join(f.projection, "notes.txt"), "work before the URL arrived\n");
        await expect(f.invoke()).rejects.toThrow("existing dirty, untracked, or unpublished work");
        expect(f.readSession().worktree).toEqual(before.worktree);
        expect(await f.git("rev-parse", "HEAD")).toBe(emptyHead);
        expect(await fs.readFile(path.join(f.projection, "notes.txt"), "utf8")).toBe(
          "work before the URL arrived\n",
        );
        await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(await f.invoke()).toMatchObject({
          status: "prepared",
          headCommit: f.headCommit,
          review: { mode: "local", base: f.commonAncestor },
        });
        expect(f.readSession()).toMatchObject({
          sessionId: before.sessionId,
          spawnedCwd: before.spawnedCwd,
          sessionRoot: before.sessionRoot,
          worktree: { ...before.worktree, githubPullRequest: { preparedHeadCommit: f.headCommit } },
        });
        expect(await f.git("rev-parse", "HEAD")).toBe(f.headCommit);
        const prTree = await f.local!.git("-C", f.upstream, "rev-parse", `${f.headCommit}^{tree}`);
        expect(await f.git("write-tree")).toBe(prTree);
        expect(await f.git("status", "--porcelain")).toBe("");
        expect(await f.guestGit("write-tree")).toBe(prTree);
        expect(await fs.readFile(path.join(f.projection, "pr.txt"), "utf8")).toBe(
          "original PR contents\n",
        );
      }
      expect(await f.guestGit("rev-parse", "HEAD")).toBe(guestHead);
      expect(await f.guestGit("symbolic-ref", "HEAD")).toBe(guestBranch);
      expect(await f.local!.git("-C", f.emptySource!, "rev-parse", "HEAD")).toBe(emptyHead);
      expect(await f.local!.git("-C", f.emptySource!, "status", "--porcelain")).toBe("");
      expect(
        await ensureEmptyWorktreeSource({
          env: process.env,
          ownerId: f.session.sessionKey,
          commitGuard: () => {},
        }),
      ).toBe(f.emptySource);
      expect(f.writes).toEqual([]);
    },
  );

  it("refuses initial dirty, untracked, and unpublished work before changing files, heads or association", async () => {
    const f = await fixture();
    const before = f.readSession();
    const initialHostHead = await f.git("rev-parse", "HEAD");
    const initialGuestHead = await f.guestGit("rev-parse", "HEAD");
    const originalContents = await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8");
    const contents = (directory: string, file: string) =>
      fs.readFile(path.join(directory, file), "utf8").catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
    for (const condition of [
      "staged-only",
      "dirty",
      "untracked",
      "guest commit",
      "host commit",
    ] as const) {
      if (condition === "staged-only") {
        await fs.writeFile(path.join(f.projection, "artifact.txt"), "private staged edit\n");
        await f.guestGit("add", "artifact.txt");
        await fs.writeFile(path.join(f.projection, "artifact.txt"), originalContents);
      } else if (condition === "dirty") {
        await fs.writeFile(path.join(f.projection, "artifact.txt"), "private unfinished edit\n");
      } else if (condition === "untracked") {
        await fs.writeFile(path.join(f.projection, "notes.txt"), "private notes\n");
      } else if (condition === "guest commit") {
        await fs.writeFile(path.join(f.projection, "notes.txt"), "unpublished guest work\n");
        await f.guestGit("add", "notes.txt");
        await f.guestGit("commit", "-m", "Unpublished guest work");
      } else {
        await fs.writeFile(path.join(f.cwd, "notes.txt"), "unpublished host work\n");
        await f.git("add", "notes.txt");
        await f.git("commit", "-m", "Unpublished host work");
      }
      const snapshot = async () => ({
        hostHead: await f.git("rev-parse", "HEAD"),
        guestHead: await f.guestGit("rev-parse", "HEAD"),
        hostStatus: await f.git("status", "--porcelain"),
        guestStatus: await f.guestGit("status", "--porcelain"),
        hostIndex: await f.git("write-tree"),
        guestIndex: await f.guestGit("write-tree"),
        hostArtifact: await contents(f.cwd, "artifact.txt"),
        guestArtifact: await contents(f.projection, "artifact.txt"),
        hostNotes: await contents(f.cwd, "notes.txt"),
        guestNotes: await contents(f.projection, "notes.txt"),
      });
      const saved = await snapshot();
      await expect(f.invoke(), condition).rejects.toThrow(
        "existing dirty, untracked, or unpublished work",
      );
      expect(f.readSession().worktree, condition).toEqual(before.worktree);
      expect(await snapshot(), condition).toEqual(saved);
      await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      // Restore only this rejected fixture change before exercising the next independent input.
      if (condition === "staged-only") {
        await f.guestGit("restore", "--staged", "artifact.txt");
      } else if (condition === "dirty") {
        await fs.writeFile(path.join(f.projection, "artifact.txt"), originalContents);
      } else if (condition === "untracked") {
        await fs.rm(path.join(f.projection, "notes.txt"));
      } else if (condition === "guest commit") {
        await f.guestGit("reset", "--hard", initialGuestHead);
      }
    }
    expect(await f.guestGit("rev-parse", "HEAD")).toBe(initialGuestHead);
    expect(await f.git("show", `${initialHostHead}:artifact.txt`)).toBe("base");
    expect(f.writes).toEqual([]);
  });

  it("preserves work from an earlier publication rather than treating its receipt as the requested PR", async () => {
    const f = await fixture({ priorPublication: true });
    const before = f.readSession();
    const head = await f.git("rev-parse", "HEAD");
    const tree = await f.git("write-tree");
    expect(await fs.readFile(path.join(f.cwd, "artifact.txt"), "utf8")).toBe("accepted\n");
    await expect(f.invoke()).rejects.toThrow("existing dirty, untracked, or unpublished work");
    expect(f.readSession().worktree).toEqual(before.worktree);
    expect(await f.git("rev-parse", "HEAD")).toBe(head);
    expect(await f.git("write-tree")).toBe(tree);
    expect(await fs.readFile(path.join(f.projection, "artifact.txt"), "utf8")).toBe("accepted\n");
    expect(f.publishedTitles).toEqual(["earlier-pr"]);
    expect(f.writes).toEqual([]);
    expect(f.externalWrites).toEqual([]);
  });

  it.each(["authorized", "wrong author", "role", "linked identity"])(
    "keeps private source transfer bound to the current requester (%s)",
    async (variant) => {
      const f = await fixture({ fork: true });
      f.pr.base.repo.private = true;
      f.pr.head.repo.private = true;
      if (variant === "wrong author") {
        f.pr.user.id = 999;
      }
      const snapshot = async () => ({
        worktree: structuredClone(f.readSession().worktree),
        hostHead: await f.git("rev-parse", "HEAD"),
        guestHead: await f.guestGit("rev-parse", "HEAD"),
        hostIndex: await f.git("write-tree"),
        guestIndex: await f.guestGit("write-tree"),
        hostStatus: await f.git("status", "--porcelain"),
        guestStatus: await f.guestGit("status", "--porcelain"),
      });
      const before = await snapshot();
      const transport = mocks.runCommand.getMockImplementation()!;
      let privateAccessReads = 0;
      let fetched = false;
      let authorityChanged = false;
      mocks.runCommand.mockImplementation(
        async (
          argv: string[],
          options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
        ) => {
          if (argv[0] === "gh" && argv.includes("GET") && argv.at(-1) === "user/101") {
            return commandResult(JSON.stringify({ id: 101, login: "contributor" }));
          }
          if (
            argv[0] === "gh" &&
            argv.includes("GET") &&
            argv.at(-1)?.endsWith("/collaborators/contributor/permission")
          ) {
            privateAccessReads += 1;
            return commandResult(
              JSON.stringify({ permission: "read", user: { id: 101, login: "contributor" } }),
            );
          }
          const result = await transport(argv, options);
          if (argv.includes("fetch") && argv.includes(f.headCommit)) {
            expect(result.code).toBe(0);
            fetched = true;
            if (!authorityChanged && variant === "role") {
              await f.revoke();
              authorityChanged = true;
            } else if (!authorityChanged && variant === "linked identity") {
              await linkCanonicalUserProfileEmail(
                "publication-guest@example.test",
                f.maintainerProfile,
              );
              authorityChanged = true;
            }
          }
          return result;
        },
      );
      if (variant === "authorized") {
        await expect(f.invoke()).resolves.toMatchObject({
          status: "prepared",
          headCommit: f.headCommit,
        });
        expect(await fs.readFile(path.join(f.projection, "pr.txt"), "utf8")).toBe(
          "original PR contents\n",
        );
      } else {
        await expect(f.invoke()).rejects.toThrow(
          variant === "wrong author" ? "could not be verified as yours" : undefined,
        );
        expect(await snapshot()).toEqual(before);
        for (const directory of [f.cwd, f.projection]) {
          await expect(fs.stat(path.join(directory, "pr.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      }
      expect(privateAccessReads).toBeGreaterThan(0);
      expect(fetched).toBe(variant !== "wrong author");
      expect(authorityChanged).toBe(variant === "role" || variant === "linked identity");
      expect(f.writes).toEqual([]);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it("checks current write eligibility before binding or changing the workspace", async () => {
    const f = await fixture({ fork: true });
    const before = f.readSession();
    const head = await f.git("rev-parse", "HEAD");
    f.pr.maintainer_can_modify = false;
    await expect(f.invoke()).rejects.toThrow("no observed write permission");
    f.pr.maintainer_can_modify = true;
    f.branch.protected = true;
    await expect(f.invoke()).rejects.toThrow("head branch is protected");
    f.branch.protected = false;
    f.branch.commit.sha = "f".repeat(40);
    await expect(f.invoke()).rejects.toThrow("head branch changed");
    f.branch.commit.sha = f.headCommit;
    f.pr.head.repo.archived = true;
    await expect(f.invoke()).rejects.toThrow("repository is archived");
    expect(f.readSession().worktree).toEqual(before.worktree);
    expect(await f.git("rev-parse", "HEAD")).toBe(head);
    await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.writes).toEqual([]);
  });

  it.each(["different repository", "pending refresh"])(
    "refuses %s before binding or applying PR files",
    async (reason) => {
      const f = await fixture({ conflict: true });
      if (reason === "different repository") {
        mocks.resolveRepository.mockResolvedValue({
          checkoutRoot: f.cwd,
          repoRoot: f.cwd,
          fingerprint: "fingerprint-1",
          originUrl: "https://github.com/other/project.git",
        });
      } else {
        await fs.writeFile(path.join(f.cwd, "artifact.txt"), "existing workspace work\n");
        await f.git("add", "artifact.txt");
        await f.git("commit", "-m", "Existing workspace work");
        await f.git("fetch", f.upstream, f.headCommit);
        await expect(f.git("merge", "--no-commit", "--no-ff", f.headCommit)).rejects.toThrow();
        expect(await f.git("rev-parse", "MERGE_HEAD")).toBe(f.headCommit);
      }
      const before = f.readSession();
      const files = await fs.readFile(path.join(f.cwd, "artifact.txt"), "utf8");
      const head = await f.git("rev-parse", "HEAD");
      await expect(f.invoke()).rejects.toThrow(
        reason === "different repository" ? "another repository" : "Finish refresh_base",
      );
      expect(f.readSession().worktree).toEqual(before.worktree);
      expect(await f.git("rev-parse", "HEAD")).toBe(head);
      expect(await fs.readFile(path.join(f.cwd, "artifact.txt"), "utf8")).toBe(files);
      await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(f.writes).toEqual([]);
    },
  );

  it.each([false, true])(
    "recovers an interrupted initial exact install (bound runtime=%s)",
    async (boundRuntime) => {
      const f = await fixture();
      using projection = boundRuntime
        ? await prepareLocalSandboxWorkspace({
            cfg: f.config,
            agentId: "main",
            sessionKey: f.session.sessionKey,
            workspaceDir: f.cwd,
            sandbox: resolveSandboxConfigForAgent(f.config, "main"),
          })
        : undefined;
      if (boundRuntime && !projection) {
        throw new Error("Expected the production managed sandbox projection");
      }
      let runtimePaused = false;
      if (projection) {
        await updateRegistry({
          containerName: "existing-pr-recovery",
          backendId: "docker",
          sessionKey: f.session.sessionKey,
          workspaceDir: f.projection,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "fixture",
        });
        vi.spyOn(sandboxEngine, "execContainer").mockImplementation(async (_engine, args) => {
          if (args[0] === "inspect") {
            return {
              code: 0,
              stderr: "",
              stdout: args.includes("{{.State.Paused}}")
                ? String(runtimePaused)
                : `${"a".repeat(64)} true ${runtimePaused}`,
            };
          }
          if (args[0] === "pause" || args[0] === "unpause") {
            runtimePaused = args[0] === "pause";
            return { code: 0, stdout: "", stderr: "" };
          }
          throw new Error(`Unexpected container command: ${args[0]}`);
        });
        const shell = f.sandbox.backend!.runShellCommand.bind(f.sandbox.backend);
        f.sandbox.backend!.runShellCommand = async (params) =>
          runtimePaused
            ? { code: 125, stdout: Buffer.alloc(0), stderr: Buffer.from("Container is paused") }
            : shell(params);
        f.sandbox.fsBridge = createSandboxFsBridge({
          sandbox: { ...f.sandbox, backend: f.sandbox.backend! },
        });
        // Reconciliation and backend admission stay real; only container I/O is simulated.
        bindLocalSandboxWorkspace(f.sandbox, projection);
      }
      const originalHead = await f.git("rev-parse", "HEAD");
      const guestHead = await f.guestGit("rev-parse", "HEAD");
      const guestBranch = await f.guestGit("symbolic-ref", "HEAD");
      const withStore = workspaceStore.withLocalWorkspaceStore;
      let interrupted = false;
      const interruption = vi
        .spyOn(workspaceStore, "withLocalWorkspaceStore")
        .mockImplementation((params, operation) =>
          withStore(params, (store) =>
            operation({
              ...store,
              update: async (row, patch, authority) => {
                const result = await store.update(row, patch, authority);
                if (
                  !interrupted &&
                  patch.pending_target === "projection" &&
                  isLocalWorkspaceBaseRefreshRef(result.pending_ref)
                ) {
                  interrupted = true;
                  throw new Error("interrupted after initial canonical acceptance");
                }
                return result;
              },
            }),
          ),
        );
      try {
        await expect(f.invoke()).rejects.toThrow(
          "Accepted workspace publication is indeterminate and requires recovery",
        );
      } finally {
        interruption.mockRestore();
      }
      expect(interrupted).toBe(true);
      expect(f.readSession().worktree?.githubPullRequest).toMatchObject({
        head: { commit: f.headCommit },
      });
      expect(f.readSession().worktree?.githubPullRequest?.preparedHeadCommit).toBeUndefined();
      expect(await f.git("rev-parse", "HEAD")).toBe(originalHead);
      expect(await f.git("rev-parse", "ORIG_HEAD")).toBe(originalHead);
      expect(await f.git("show", "ORIG_HEAD:newer-base.txt")).toBe("base advanced after PR");
      if (boundRuntime) {
        expect(runtimePaused).toBe(true);
      }
      await f.advanceHead({ "newer-pr.txt": "remote advanced during first import\n" });
      if (!boundRuntime) {
        await closeOpenClawAgentDatabasesAsync();
      }
      expect(await f.invoke()).toMatchObject({
        status: "prepared",
        headCommit: f.headCommit,
        headChanged: true,
      });
      expect(runtimePaused).toBe(false);
      expect(await f.git("rev-parse", "HEAD")).toBe(f.headCommit);
      expect(await f.git("diff", "--name-only", f.headCommit)).toBe("");
      expect(await f.guestGit("rev-parse", "HEAD")).toBe(guestHead);
      expect(await f.guestGit("symbolic-ref", "HEAD")).toBe(guestBranch);
      expect(await fs.readFile(path.join(f.projection, "pr.txt"), "utf8")).toBe(
        "original PR contents\n",
      );
      await expect(fs.stat(path.join(f.projection, "newer-base.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(path.join(f.projection, "newer-pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(f.readSession().worktree?.githubPullRequest?.preparedHeadCommit).toBe(f.headCommit);
      expect(f.writes).toEqual([]);
    },
  );
});

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
import { Value } from "typebox/value";
import { expect, vi } from "vitest";
import { SessionGitHubPullRequestPrepareResultSchema } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
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
import { syncCanonicalGitHubIdentity } from "../state/user-profile-writes.js";
import { createRequesterPublicationFixture } from "./github-publication-requester.test-support.js";
import { commandResult, githubPublicationTestMocks } from "./github-publication.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createContext as createRequestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "./worker-environments/local-workspace-projection.js";

export const mocks = githubPublicationTestMocks();

const isolatedGitEnv = (env: NodeJS.ProcessEnv = {}) => ({
  ...process.env,
  ...env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
  GH_CONFIG_DIR: undefined,
});

export async function fixture(
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
  const upstreamGit = (...args: string[]) => local.git("-C", upstream, ...args);
  const commitUpstream = async (message: string, files: Record<string, string>) => {
    for (const [file, contents] of Object.entries(files)) {
      await fs.writeFile(path.join(upstream, file), contents);
    }
    await upstreamGit("add", "-A");
    await upstreamGit("commit", "-m", message);
    return upstreamGit("rev-parse", "HEAD");
  };
  await local.git("clone", "--no-local", "--branch", "main", local.cwd, upstream);
  const commonAncestor = await upstreamGit("rev-parse", "HEAD");
  await upstreamGit("checkout", "-b", "topic/existing");
  const headCommit = await commitUpstream("Existing PR work", {
    "pr.txt": "original PR contents\n",
    ...(options.conflict ? { "artifact.txt": "original PR change\n" } : {}),
  });
  await upstreamGit("checkout", "main");
  const baseCommit = await commitUpstream("Newer base work", {
    "newer-base.txt": "base advanced after PR\n",
  });
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
        const reads: Record<string, unknown> = {
          "repos/openclaw/openclaw": baseRepo,
          "repos/contributor/openclaw": headRepo,
          [`repos/openclaw/openclaw/pulls/${pr.number}`]: pr,
        };
        const value = endpoint.includes("/branches/") ? branch : reads[endpoint];
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
            env: isolatedGitEnv(commandOptions?.env),
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
              env: isolatedGitEnv({
                GIT_AUTHOR_NAME: "Guest",
                GIT_AUTHOR_EMAIL: "guest@example.test",
                GIT_COMMITTER_NAME: "Guest",
                GIT_COMMITTER_EMAIL: "guest@example.test",
              }),
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
    signal?: AbortSignal,
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
        signal,
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, result, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error.message);
      }
      return result as T;
    };
    const toolArgs = { action: "prepare_pr", pullRequestUrl: pr.html_url, ...args };
    const result = await withGatewayToolCallerIdentity(scope, () =>
      withPublicationToolTransport(callGateway, () =>
        createGitHubPublishTool({ sandbox: prepared }).execute(
          "prepare",
          Object.fromEntries(Object.entries(toolArgs).filter(([, value]) => value !== undefined)),
        ),
      ),
    );
    if ((args.action ?? "prepare_pr") === "prepare_pr") {
      expect(Value.Check(SessionGitHubPullRequestPrepareResultSchema, result.details)).toBe(true);
    }
    return result.details;
  };
  const advanceHead = async (files: Record<string, string>) => {
    await upstreamGit("checkout", "topic/existing");
    pr.head.sha = await commitUpstream("Advance existing PR", files);
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

export async function bindFixtureRuntime(f: Awaited<ReturnType<typeof fixture>>) {
  const projection = await prepareLocalSandboxWorkspace({
    cfg: f.config,
    agentId: "main",
    sessionKey: f.session.sessionKey,
    workspaceDir: f.cwd,
    sandbox: resolveSandboxConfigForAgent(f.config, "main"),
  });
  if (!projection) {
    throw new Error("Expected the production managed sandbox projection");
  }
  let runtimePaused = false;
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
  return { projection, isPaused: () => runtimePaused };
}

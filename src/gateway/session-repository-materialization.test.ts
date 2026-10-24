import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as githubOAuth from "../agents/github-oauth-client.js";
import { createGitHubReadIdentity } from "../agents/github-read-identity.js";
import {
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../agents/github-tool-identity.js";
import { findLiveRegistryWorktreeByOwner } from "../agents/worktrees/registry.test-support.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessionEntries from "../config/sessions/session-accessor.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as cloneRuntime from "../projects/project-clone-runtime.js";
import { ProjectCloneError } from "../projects/project-clone-runtime.js";
import * as projectCloning from "../projects/project-clone.js";
import { registerClonedProjectRegistry } from "../projects/project-registry.test-support.js";
import * as secretsRuntime from "../secrets/runtime-state.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as githubOAuthLifecycle from "./github-oauth-lifecycle.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import { REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS } from "./github-repository-publication-snapshot.js";
import { materializeSessionRepositoryWorkspaceOnGateway } from "./session-repository-materialization.js";
import * as repositoryGitHubIdentity from "./worker-environments/repository-github-identity.js";
import { stageSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";
import { captureWorkspaceManifest } from "./worker-environments/workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./worker-environments/workspace-manifest.js";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const enterpriseGitHub = {
  host: "ghe.example.test",
  apiBaseUrl: "https://ghe.example.test/api/v3",
};
const readFile = (root: string, name: string) => fsp.readFile(path.join(root, name), "utf8");

async function createRepository(
  scope: { agentId: string; sessionKey: string },
  url: string,
  baseCommit: string,
  baseManifestHash: string,
  requestedRef?: string,
) {
  const store = getSessionRepositoryWorkspaceStore();
  const created = await store.create({
    ...scope,
    url,
    requestedRef,
    runSetupScript: false,
    assertCurrent: () => {},
  });
  return store.bindBase({
    workspaceId: created.workspaceId,
    expectedRevision: created.revision,
    baseCommit,
    baseManifestHash,
    assertCurrent: () => {},
  });
}

afterEach(() => {
  memorySessionActorOwners.reset();
  vi.restoreAllMocks();
});

it.each([
  "system",
  "agent",
  "enterprise",
  "host mismatch",
  "revoked",
  "reset",
  "clone reset",
  "auth failure",
  "unavailable identity",
] as const)(
  "keeps the current shared GitHub identity and move authority at clone admission: %s",
  async (scenario) => {
    await withOpenClawTestState(
      {
        label: "repository-materialize-identity",
        env: {
          GH_TOKEN: "synthetic-legacy-token",
          GITHUB_TOKEN: undefined,
          GH_ENTERPRISE_TOKEN: scenario === "enterprise" ? "synthetic-enterprise-token" : undefined,
          GITHUB_ENTERPRISE_TOKEN: undefined,
          GH_HOST: scenario === "enterprise" ? "ghe.example.test" : undefined,
        },
      },
      async (state) => {
        const systemProfileId = "ghp_11111111111111111111111111111111";
        const agentProfileId = "ghp_22222222222222222222222222222222";
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          gateway: {
            controlUi: { github: { token: "synthetic-preview-token" } },
            ...(["enterprise", "host mismatch"].includes(scenario)
              ? { github: enterpriseGitHub }
              : {}),
          },
        };
        const config: OpenClawConfig = {
          ...cfg,
          ...(scenario === "enterprise"
            ? {}
            : { tools: { github: { profileId: systemProfileId } } }),
          agents: {
            entries: {
              main: {
                workspace: state.workspaceDir,
                ...(scenario === "agent"
                  ? { tools: { github: { profileId: agentProfileId } } }
                  : {}),
              },
            },
          },
        };
        await state.writeConfig(config);
        setRuntimeConfigSnapshot(config);
        vi.spyOn(secretsRuntime, "getActiveSecretsRuntimeConfigSnapshot").mockReturnValue({
          config,
          sourceConfig: config,
          configRefsPrepared: true,
        });
        vi.spyOn(githubOAuthLifecycle, "requestCurrentGitHubOAuthRefresh").mockResolvedValue(
          undefined,
        );
        for (const [credentialScope, profileId] of [
          ["system", systemProfileId],
          ["agent", agentProfileId],
        ] as const) {
          await writeManagedGitHubProfileFiles(
            resolveManagedGitHubProfileDir({
              agentId: "main",
              scope: credentialScope,
              profileId,
            }),
            { login: `${credentialScope}-bot`, token: `synthetic-${credentialScope}-token` },
          );
        }
        const scope = { agentId: "main", sessionKey: "agent:main:dashboard:private-move" };
        const sessionId = "private-materialization-session";
        const repository = await createRepository(
          scope,
          `https://${scenario === "enterprise" ? "ghe.example.test" : "github.com"}/openclaw/private-materialization-fixture.git`,
          "a".repeat(40),
          `sha256:${"b".repeat(64)}`,
        );
        await upsertSessionEntryCore(scope, {
          sessionId,
          repositoryWorkspaceId: repository.workspaceId,
        });
        let current = true;
        const verify = vi
          .spyOn(githubOAuth, "verifyGitHubCredential")
          .mockImplementation(async () => {
            await Promise.resolve();
            if (scenario === "revoked") {
              current = false;
            } else if (scenario === "reset") {
              await sessionEntries.patchSessionEntryCore(scope, () => ({
                lifecycleRevision: "reset-revision",
              }));
            }
            if (scenario === "unavailable identity") {
              return { status: "unavailable" };
            }
            return {
              status: "available",
              account: { accountId: 42, login: "shared-bot", avatarUrl: null },
              scopes: [],
            };
          });
        const cloneFailure =
          scenario === "auth failure"
            ? new ProjectCloneError("auth_required", "GitHub rejected the Control UI credential")
            : new Error("fixture clone transport reached");
        const clone = vi
          .spyOn(projectCloning, "materializeProjectClone")
          .mockImplementation(async (_request, options) => {
            if (scenario === "clone reset") {
              const sql = observeHostDataSql();
              try {
                expect(options?.assertCurrent).toBeTypeOf("function");
                options?.assertCurrent?.();
                expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
                await sessionEntries.patchSessionEntryCore(scope, () => ({
                  lifecycleRevision: "reset-at-clone-effect",
                }));
                expect(options?.assertCurrent).toThrow("Repository workspace changed");
                expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
              } finally {
                sql.restore();
              }
            }
            throw cloneFailure;
          });
        const operation = materializeSessionRepositoryWorkspaceOnGateway({
          ...scope,
          cfg,
          sessionId,
          assertCurrent: () => {
            if (!current) {
              throw new Error("move authority revoked");
            }
          },
        });
        const rejections: Partial<Record<typeof scenario, string | RegExp>> = {
          "host mismatch": "configured GitHub host (ghe.example.test)",
          "unavailable identity": /reconnect.*GitHub identity/iu,
          revoked: "move authority revoked",
          reset: "Repository workspace changed",
        };
        const rejection = rejections[scenario];
        if (rejection) {
          await expect(operation).rejects.toThrow(rejection);
          expect(clone).not.toHaveBeenCalled();
          if (scenario === "host mismatch") {
            expect(verify).not.toHaveBeenCalled();
          }
        } else {
          if (scenario === "auth failure") {
            await expect(operation).rejects.toMatchObject({
              failure: "auth_required",
              message: expect.stringMatching(/shared GitHub identity.*Settings/u),
            });
          } else {
            await expect(operation).rejects.toBe(cloneFailure);
          }
          const token =
            scenario === "enterprise"
              ? "synthetic-enterprise-token"
              : `synthetic-${scenario === "agent" ? "agent" : "system"}-token`;
          expect(verify).toHaveBeenCalledWith(token, {
            apiBaseUrl:
              scenario === "enterprise"
                ? "https://ghe.example.test/api/v3"
                : "https://api.github.com",
          });
          expect(clone).toHaveBeenCalledWith(
            { cfg, gitUrl: repository.url, requiredCommit: repository.baseCommit },
            expect.objectContaining({ token }),
          );
        }
        expect(loadSessionEntry(scope)?.repositoryWorkspaceId).toBe(repository.workspaceId);
        expect(await managedWorktrees.findLiveByOwner("session", scope.sessionKey)).toBeUndefined();
      },
    );
  },
);

it.each([
  "enterprise",
  "revoked",
  "postcommit failure",
  "publication unavailable",
  "requested topic",
  "unbound incognito",
] as const)("retains only committed materialization: %s", async (outcome) => {
  // Local recovery fixtures exercise retained state; identity admission is covered above.
  vi.spyOn(repositoryGitHubIdentity, "prepareRepositoryGitHubIdentity").mockImplementation(
    async (_agentId, assertCurrent) =>
      createGitHubReadIdentity({
        token: undefined,
        selection: { source: "anonymous" },
        assertSelected: assertCurrent,
        readToken: async () => undefined,
      }),
  );
  await withOpenClawTestState({ label: "repository-materialize" }, async (state) => {
    const cfg = {
      ...(outcome === "enterprise" ? { gateway: { github: enterpriseGitHub } } : {}),
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      tools: { github: { profileId: "ghp_11111111111111111111111111111111" } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const source = state.path("source");
    await fsp.mkdir(source);
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "user.name", "OpenClaw Test"]);
    await git(source, ["config", "user.email", "test@example.invalid"]);
    await fsp.writeFile(path.join(source, ".gitignore"), "*.ignored\n");
    await fsp.writeFile(path.join(source, ".worktreeinclude"), "retained.ignored\n");
    await fsp.writeFile(path.join(source, "edited.txt"), "base\n");
    await fsp.writeFile(path.join(source, "deleted.txt"), "delete me\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "base"]);
    const baseCommit = await git(source, ["rev-parse", "HEAD"]);
    const url = `https://${outcome === "enterprise" ? "ghe.example.test" : "github.com"}/openclaw/materialization-fixture.git`;
    await registerClonedProjectRegistry({ path: source, name: "Fixture", originUrl: url });
    const base = await captureWorkspaceManifest({ root: source, baseCommit });
    const remote = state.path("remote");
    await exec("git", ["clone", "--", source, remote]);
    await fsp.writeFile(path.join(remote, "published[1].ignored"), "publishable\n");
    await fsp.writeFile(path.join(remote, "retained.ignored"), "recovery only\n");
    await git(remote, ["--literal-pathspecs", "add", "-f", "--", "published[1].ignored"]);
    await fsp.writeFile(path.join(remote, "edited.txt"), "accepted\n");
    await fsp.writeFile(path.join(remote, "added.txt"), "new\n");
    await fsp.rm(path.join(remote, "deleted.txt"));
    const current = await captureWorkspaceManifest({ root: remote, baseCommit });
    const publicationStagingRoot = state.path("publication-snapshot");
    const publicationDigest =
      outcome === "publication unavailable"
        ? undefined
        : (
            await exec(process.execPath, [
              "-e",
              REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
              remote,
              baseCommit,
              publicationStagingRoot,
            ])
          ).stdout.trim();
    const scope = {
      agentId: "main",
      sessionKey:
        outcome === "unbound incognito"
          ? "agent:main:dashboard:incognito-materialization"
          : "agent:main:dashboard:materialization",
    };
    const repositories = getSessionRepositoryWorkspaceStore();
    let repository = await createRepository(
      scope,
      url,
      baseCommit,
      base.manifestRef,
      outcome === "requested topic" ? "topic" : undefined,
    );
    const checkpoint = await stageSessionRepositoryCheckpoint({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      stagingRoot: remote,
      ...(publicationDigest ? { publicationStagingRoot, publicationDigest } : {}),
      baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
      currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
      baseManifestRef: base.manifestRef,
      currentManifestRef: current.manifestRef,
      assertCurrent: () => {},
    });
    repository = await checkpoint.publish();
    const sessionId = "repository-materialization-session";
    const owner =
      outcome === "unbound incognito"
        ? memorySessionActorOwners.get({
            agentId: "main",
            path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
          })
        : undefined;
    const actor = await owner?.acquire(
      { database: owner.identity, sessionKey: scope.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const authority = { assertCurrent() {}, authorize() {} };
    const readEntry = () =>
      owner ? owner.readSession(scope.sessionKey, authority)?.entry : loadSessionEntry(scope);
    try {
      const entry = { sessionId, repositoryWorkspaceId: repository.workspaceId };
      if (actor) {
        const created = await actor.storage!.mutate(
          {
            type: "session.entry.create",
            input: { entry: { ...entry, updatedAt: Date.now(), incognito: true } },
          },
          authority,
        );
        expect(created.kind).toBe("committed");
      } else {
        await upsertSessionEntryCore(scope, entry);
      }
      const assertCurrent = () => {
        const worktree = findLiveRegistryWorktreeByOwner(process.env, "session", scope.sessionKey);
        if (
          outcome === "revoked" &&
          worktree &&
          fs.existsSync(path.join(worktree.path, "added.txt"))
        ) {
          throw new Error("move authority revoked");
        }
      };
      vi.spyOn(cloneRuntime, "readProjectCheckoutRemoteHead").mockImplementation(
        async ({ branch }) =>
          outcome === "requested topic" && branch === "topic" ? baseCommit : undefined,
      );
      if (outcome === "postcommit failure") {
        const patchSessionEntry = sessionEntries.patchSessionEntryCore;
        vi.spyOn(sessionEntries, "patchSessionEntryCore").mockImplementationOnce(
          async (...args) => {
            await patchSessionEntry(...args);
            throw new Error("postcommit observer failed");
          },
        );
      }
      const operation = materializeSessionRepositoryWorkspaceOnGateway({
        ...scope,
        cfg,
        sessionId,
        assertCurrent,
      });
      if (outcome === "revoked") {
        await expect(operation).rejects.toThrow("move authority revoked");
        expect(readEntry()?.repositoryWorkspaceId).toBe(repository.workspaceId);
        expect(await managedWorktrees.findLiveByOwner("session", scope.sessionKey)).toBeUndefined();
      } else {
        if (outcome === "postcommit failure") {
          await expect(operation).rejects.toThrow("postcommit observer failed");
        } else {
          await operation;
        }
        const materialized = readEntry()!;
        const worktree = (await managedWorktrees.findLiveByOwner("session", scope.sessionKey))!;
        expect(materialized.repositoryWorkspaceId).toBeUndefined();
        expect(worktree.baseRef).toBe(outcome === "requested topic" ? "topic" : "HEAD");
        expect(materialized).toMatchObject({
          worktree: { id: worktree.id },
          spawnedCwd: worktree.path,
        });
        expect(await readFile(worktree.path, "edited.txt")).toBe("accepted\n");
        expect(await readFile(worktree.path, "added.txt")).toBe("new\n");
        await expect(fsp.stat(path.join(worktree.path, "deleted.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await git(worktree.path, ["rev-parse", "HEAD"])).toBe(baseCommit);
        expect(await readFile(worktree.path, "published[1].ignored")).toBe("publishable\n");
        expect(await readFile(worktree.path, "retained.ignored")).toBe("recovery only\n");
        expect(await git(worktree.path, ["ls-files", "--", "published[1].ignored"])).toBe(
          publicationDigest ? "published[1].ignored" : "",
        );
        expect(await git(worktree.path, ["ls-files", "--", "retained.ignored"])).toBe("");
        expect(await git(worktree.path, ["diff", "--cached", "--name-only"])).toBe(
          publicationDigest ? "deleted.txt" : "",
        );
        const normalized = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: worktree.path,
        });
        const published = (
          await git(worktree.path, ["ls-tree", "-r", "--name-only", normalized.workspaceTree])
        ).split("\n");
        expect(published.includes("published[1].ignored")).toBe(Boolean(publicationDigest));
        expect(published).not.toContain("retained.ignored");
        await materializeSessionRepositoryWorkspaceOnGateway({
          ...scope,
          cfg,
          sessionId,
          assertCurrent,
        });
        expect((await managedWorktrees.findLiveByOwner("session", scope.sessionKey))?.id).toBe(
          worktree.id,
        );
      }
      // Retained publication may still need the original immutable source after the move.
      expect(await repositories.get(repository.workspaceId)).toEqual(repository);
      expect(fs.existsSync(repositories.artifactPath(repository.workspaceId))).toBe(true);
      expect(await readFile(source, "edited.txt")).toBe("base\n");
    } finally {
      await actor?.release();
    }
  });
});

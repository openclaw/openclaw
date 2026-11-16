import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { Value } from "typebox/value";
import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as identity from "../../agents/github-tool-identity.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import * as gatewayTransport from "../../agents/tools/gateway.js";
import { createGitHubPublishTool } from "../../agents/tools/github-publish-tool.js";
import { runGit } from "../../agents/worktrees/git.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { makeWorktreeRecord } from "../../agents/worktrees/service.test-support.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import * as oauth from "../github-oauth-lifecycle.js";
import * as publicationTarget from "../github-publication-target.js";
import { createGitHubPublicationCoordinator } from "../github-publication.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  sessionKey,
  withReadFixture,
  type ReadFixture,
} from "./sessions-github-read.test-support.js";

export const temporary = useAutoCleanupTempDirTracker(afterEach);
export const githubOrigin = "https://github.com/example/project.git";

export async function fixture(
  run: (f: ReadFixture) => Promise<void>,
  options: Parameters<typeof withReadFixture>[1] = {},
) {
  await withReadFixture(async (f) => {
    Object.assign(f.context, createContext([], f.context.getRuntimeConfig));
    const service = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore(),
      getCommittedRuntimeConfig: f.context.getRuntimeConfig,
    });
    f.context.githubPublicationService = service;
    const forbidden = () => {
      throw new Error("Readiness attempted an external effect or credential preparation");
    };
    const effects = [
      vi.spyOn(service, "requestForSessionV2").mockImplementation(forbidden),
      vi.spyOn(service, "preparePersonalStatus").mockImplementation(forbidden),
      vi.spyOn(service, "personalPending").mockImplementation(forbidden),
      vi.spyOn(identity, "prepareGitHubPublicationIdentity").mockImplementation(forbidden),
      vi.spyOn(identity, "prepareGitHubPublicationOptionsIdentity").mockImplementation(forbidden),
      vi.spyOn(oauth, "requestCurrentGitHubOAuthRefresh").mockImplementation(forbidden),
      vi.spyOn(publicationTarget, "prepareGitHubPublicationTarget").mockImplementation(forbidden),
      vi.spyOn(gatewayTransport, "callGatewayTool").mockImplementation(forbidden),
    ];
    try {
      await run(f);
    } finally {
      for (const effect of effects) {
        expect(effect).not.toHaveBeenCalled();
        effect.mockRestore();
      }
      expect(f.personalConnectionStatus).not.toHaveBeenCalled();
    }
  }, options);
}

export async function tool(
  f: ReadFixture,
  input: Record<string, unknown>,
  caller?: Partial<NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>>,
) {
  const publisher = createGitHubPublishTool();
  // Fixture precondition: supplied arguments satisfy the schema before direct execution.
  expect(Value.Check(publisher.parameters, input)).toBe(true);
  return withPluginRuntimeGatewayRequestScope(
    { context: f.context, client: f.client, isWebchatConnect: () => false },
    () =>
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey, gatewayContextResolver: () => f.context, ...caller },
        () => publisher.execute("readiness-observation", input),
      ),
  );
}
export async function git(root: string, ...args: string[]) {
  const result = await runGit(root, args);
  assert(result.code === 0, result.stderr);
  return result.stdout.trim();
}
export async function bind(origin = githubOrigin) {
  const root = await fs.realpath(temporary.make("readiness-git-"));
  await git(root, "init", "--initial-branch=feature");
  await git(root, "config", "user.name", "Publication Fixture");
  await git(root, "config", "user.email", "publication@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "commit", "--allow-empty", "-m", "fixture");
  if (origin) {
    await git(root, "remote", "add", "origin", origin);
  }
  const repository = await managedWorktrees.resolveRepositoryIdentity(root);
  const worktree = makeWorktreeRecord(repository.repoRoot, randomUUID(), {
    path: root,
    repoFingerprint: repository.fingerprint,
    branch: "feature",
    ownerId: sessionKey,
  });
  await insertRegistryWorktree(process.env, worktree);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
    },
  );
  return worktree;
}

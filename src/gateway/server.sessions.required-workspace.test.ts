import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import {
  assertRequiredSessionWorktree,
  assertRequiredSessionWorktreeCheckout,
} from "../agents/worktrees/required-session-binding.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveWorkerPlacementSessionTarget } from "./server-worker-placement-session-target.js";
import { initializeRepository } from "./server.sessions.create.projects.test-support.js";
import { setupSessionCreateHandlerTestHarness } from "./server.sessions.create.test-support.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";
import { testState } from "./test-helpers.js";
import { directSessionReq, getGatewayConfigModule } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, withSessionTestState } = setupSessionCreateHandlerTestHarness();

async function fixture(root: string) {
  const workspace = await initializeRepository(root, "project");
  testState.agentConfig = { workspace };
  testState.agentsConfig = {
    ownership: "explicit",
    entries: { main: {} },
  };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: workspace });
  const profile = ensureProfileForEmail("workspace-contributor@example.test");
  const config = await getGatewayConfigModule();
  // Profile/registry setup can warm real IO before the test store is published.
  config.clearRuntimeConfigSnapshot();
  const cfg = config.getRuntimeConfig();
  config.setRuntimeConfigSnapshot(cfg);
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const client = {
    connect: {
      role: "operator",
      scopes: ["operator.sessions.read", "operator.sessions.write"],
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
    },
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  } as GatewayClient;
  return { workspace, storePath, project, profile, cfg, context, client };
}

async function recordRequiredSession(root: string) {
  const setup = await fixture(root);
  const key = "agent:main:dashboard:recorded-required-workspace";
  const worktree = await managedWorktrees.create({
    repoRoot: setup.workspace,
    ownerKind: "session",
    ownerId: key,
    name: "required-workspace",
    baseRef: "main",
    runSetupScript: false,
  });
  const scope = { agentId: "main", sessionKey: key, storePath: setup.storePath };
  await upsertSessionEntryCore(scope, {
    sessionId: "required-parent",
    lifecycleRevision: "required-parent-generation",
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: setup.profile.id },
    projectId: setup.project.id,
    requiredWorkspace: { projectId: setup.project.id, worktreeBaseRef: "main" },
    worktree: {
      id: worktree.id,
      repoRoot: setup.workspace,
      branch: worktree.branch,
      canonicalWorkspaceDir: setup.workspace,
    },
    sessionRoot: worktree.path,
    spawnedCwd: worktree.path,
    spawnedWorkspaceDir: worktree.path,
  });
  const entry = expectDefined(loadSessionEntry(scope), "recorded required parent");
  expect(entry).toMatchObject({
    sessionId: "required-parent",
    lifecycleRevision: "required-parent-generation",
  });
  return { ...setup, key, worktree, scope, entry };
}

test("recorded required custody survives keyed adoption and privileged writes", async () => {
  await withSessionTestState({ layout: "state-only" }, async (state) => {
    const {
      workspace,
      key,
      scope,
      entry: original,
      context,
      client,
    } = await recordRequiredSession(state.root);
    const reopened = await directSessionReq<{ entry: SessionEntry }>(
      "sessions.create",
      { key },
      { context, client },
    );
    expect(reopened.ok, JSON.stringify(reopened.error)).toBe(true);
    expect(reopened.payload?.entry).toMatchObject({
      sessionId: original.sessionId,
      requiredWorkspace: original.requiredWorkspace,
      worktree: original.worktree,
      sessionRoot: original.sessionRoot,
      spawnedCwd: original.spawnedCwd,
      spawnedWorkspaceDir: original.spawnedWorkspaceDir,
    });
    for (const override of [{ cwd: workspace }, { worktree: false }, { projectId: "different" }]) {
      const rejected = await directSessionReq(
        "sessions.create",
        { key, ...override },
        { context, client },
      );
      expect(rejected.ok).toBe(false);
    }
    await upsertSessionEntryCore(scope, {
      sessionId: "reset-generation",
      requiredWorkspace: undefined,
      worktree: undefined,
      sessionRoot: workspace,
      spawnedCwd: workspace,
      spawnedWorkspaceDir: workspace,
      execHost: "node",
    });
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "reset-generation",
      requiredWorkspace: original.requiredWorkspace,
      worktree: original.worktree,
      sessionRoot: original.sessionRoot,
      spawnedCwd: original.spawnedCwd,
      spawnedWorkspaceDir: original.spawnedWorkspaceDir,
    });
    expect(loadSessionEntry(scope)?.execHost).toBeUndefined();
  });
});

test("local lease and worker source selection reject replacement of the registered checkout", async () => {
  await withSessionTestState({ layout: "state-only" }, async (state) => {
    const { workspace, cfg, key, entry, worktree } = await recordRequiredSession(state.root);
    const lease = await acquireWorktreeRunLease(worktree.id, {
      validateCheckout: assertRequiredSessionWorktreeCheckout,
    });
    await lease.release();
    const select = () =>
      resolveWorkerPlacementSessionTarget({
        sessionRuntime: {
          resolveGatewaySessionStoreTargetWithStore,
          resolveCanonicalSessionEntryFromStoreKeys,
          managedWorktrees,
        },
        config: cfg,
        sessionId: entry.sessionId,
        sessionKey: key,
        agentId: "main",
        errorMessage: "workspace changed",
      });
    expect((await select()).workspace).toEqual({ kind: "local", path: worktree.path });
    const retainedPath = `${worktree.path}.retained`;
    await fs.rename(worktree.path, retainedPath);
    try {
      await fs.symlink(workspace, worktree.path, "dir");
      await expect(
        acquireWorktreeRunLease(worktree.id, {
          validateCheckout: assertRequiredSessionWorktreeCheckout,
        }),
      ).rejects.toThrow("required workspace");
      await expect(select()).rejects.toThrow("required workspace");
    } finally {
      await fs.rm(worktree.path);
      await fs.rename(retainedPath, worktree.path);
    }
  });
});

test("hidden children borrow exact custody until parent reset and never own checkout cleanup", async () => {
  await withSessionTestState({ layout: "state-only" }, async (state) => {
    const {
      project,
      cfg,
      context,
      client,
      key,
      worktree,
      scope,
      entry: parent,
    } = await recordRequiredSession(state.root);
    const childScope = { ...scope, sessionKey: "agent:main:subagent:required-child" };
    const { createInitialSubagentSession } =
      await import("../agents/subagents/spawn/subagent-spawn-session-patch.js");
    const childParams = {
      cfg,
      targetAgentId: "main",
      childSessionKey: childScope.sessionKey,
      incognito: false,
      requesterInternalKey: key,
      completionOwnerSessionKey: key,
      creationPolicy: { actor: { type: "agent" as const, id: "main" } },
      modelPatch: {},
      collect: false,
    };
    const refusedKey = "agent:main:subagent:required-worktree-override";
    const refused = await createInitialSubagentSession({
      ...childParams,
      childSessionKey: refusedKey,
      worktree: { projectId: project.id, task: "separate checkout" },
    });
    expect(refused).toMatchObject({
      status: "error",
      error: expect.stringContaining("exact authorized workspace"),
    });
    expect(loadSessionEntry({ ...scope, sessionKey: refusedKey })).toBeUndefined();
    expect(managedWorktrees.findLiveByOwner("session", refusedKey)).toBeUndefined();
    const childCreation = await createInitialSubagentSession(childParams);
    expect(
      childCreation.status,
      childCreation.status === "error" ? childCreation.error : undefined,
    ).toBe("ok");
    const child = loadSessionEntry(childScope)!;
    expect(child).toMatchObject({
      parentSessionId: parent.sessionId,
      parentLifecycleRevision: parent.lifecycleRevision,
      requiredWorkspace: parent.requiredWorkspace,
      worktree: parent.worktree,
    });
    const binding = {
      entry: child,
      cfg,
      sessionKey: childScope.sessionKey,
      record: managedWorktrees.findLiveByOwner("session", key),
      candidatePaths: [worktree.path],
    };
    await expect(assertRequiredSessionWorktree(binding)).resolves.toBeUndefined();
    const reset = await directSessionReq("sessions.reset", { key }, { context, client });
    expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
    const resetParent = loadSessionEntry(scope)!;
    expect(resetParent.sessionId).toBe(parent.sessionId);
    expect(resetParent.lifecycleRevision).not.toBe(parent.lifecycleRevision);
    expect(resetParent.requiredWorkspace).toEqual(parent.requiredWorkspace);
    expect(resetParent.worktree).toEqual(parent.worktree);
    await expect(assertRequiredSessionWorktree(binding)).rejects.toThrow("required workspace");
    // A borrowed child owns only its conversation, even after its parent reset.
    const archived = await directSessionReq(
      "sessions.patch",
      {
        key: childScope.sessionKey,
        archived: true,
        expectedSessionId: child.sessionId,
        expectedLifecycleRevision: child.lifecycleRevision,
      },
      { context },
    );
    expect(archived.ok, JSON.stringify(archived.error)).toBe(true);
    const deleted = await directSessionReq(
      "sessions.delete",
      { key: childScope.sessionKey },
      { context },
    );
    expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
    expect(managedWorktrees.findLiveByOwner("session", key)?.id).toBe(worktree.id);
    expect(await fs.realpath(worktree.path)).toBe(worktree.path);
  });
});

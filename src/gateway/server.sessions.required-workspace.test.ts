import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { requireGit } from "../agents/worktrees/git.js";
import {
  assertRequiredSessionWorktree,
  assertRequiredSessionWorktreeCheckout,
} from "../agents/worktrees/required-session-binding.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { resolveWorkerPlacementSessionTarget } from "./server-worker-placement-session-target.js";
import { initializeRepository } from "./server.sessions.create.projects.test-support.js";
import { setupSessionCreateHandlerTestHarness } from "./server.sessions.create.test-support.js";
import { recoverGatewaySession } from "./session-recovery-service.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";
import { testState } from "./test-helpers.js";
import { directSessionReq, getGatewayConfigModule } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, withSessionTestState } = setupSessionCreateHandlerTestHarness();

async function fixture(root: string, required = false) {
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
  const baseConfig = config.getRuntimeConfig();
  const cfg: OpenClawConfig = {
    ...baseConfig,
    ...(required
      ? {
          gateway: {
            ...baseConfig.gateway,
            roles: {
              default: "contributor",
              definitions: {
                contributor: {
                  sessions: {
                    others: "view",
                    workspace: { projects: [project.id], worktreeBaseRef: "main" },
                  },
                  agents: ["main"],
                  scopes: ["operator.sessions.read", "operator.sessions.write"],
                },
              },
            },
          },
        }
      : {}),
  };
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
test("selected project creates a fresh main-based worktree before the session is usable", async () => {
  await withSessionTestState({ layout: "state-only" }, async (state) => {
    const { workspace, storePath, project, context, client } = await fixture(state.root, true);
    const base = await requireGit(workspace, ["rev-parse", "main"]);
    await requireGit(workspace, ["checkout", "-b", "unrelated-work"]);
    await requireGit(workspace, ["commit", "--allow-empty", "-m", "unrelated head"]);
    const created = await directSessionReq<{
      key: string;
      entry: SessionEntry;
      worktree: { id: string; path: string };
    }>("sessions.create", { projectId: project.id }, { context, client });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const payload = created.payload!;
    expect(payload.worktree.path).not.toBe(workspace);
    expect(await requireGit(payload.worktree.path, ["rev-parse", "HEAD"])).toBe(base);
    const record = managedWorktrees.findLiveByOwner("session", payload.key);
    expect(record).toMatchObject({
      id: payload.worktree.id,
      baseRef: "main",
      ownerId: payload.key,
    });
    const scope = { agentId: "main", sessionKey: payload.key, storePath };
    const original = loadSessionEntry(scope)!;
    expect(original).toMatchObject({
      requiredWorkspace: { projectId: project.id, worktreeBaseRef: "main" },
      sessionRoot: payload.worktree.path,
      spawnedWorkspaceDir: payload.worktree.path,
    });
    const read = await directSessionReq("sessions.get", { key: payload.key }, { context, client });
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    const fork = await directSessionReq<{ key: string; worktree: { id: string; path: string } }>(
      "sessions.create",
      { fork: true, parentSessionKey: payload.key },
      { context, client },
    );
    expect(fork.ok, JSON.stringify(fork.error)).toBe(true);
    expect(fork.payload?.worktree.id).not.toBe(payload.worktree.id);
    expect(await requireGit(fork.payload!.worktree.path, ["rev-parse", "HEAD"])).toBe(base);
  });
});

test.each([undefined, "required"] as const)(
  "named maintainer recovery preserves original creator and workspace custody (sandbox: %s)",
  async (sandbox) => {
    await withSessionTestState({ layout: "state-only" }, async (state) => {
      const { workspace, project, storePath, cfg, context, client } = await fixture(
        state.root,
        true,
      );
      expectDefined(cfg.gateway?.roles?.definitions.contributor, "contributor role").sandbox =
        sandbox;
      const created = await directSessionReq<{ key: string; entry: SessionEntry }>(
        "sessions.create",
        { projectId: project.id },
        { context, client },
      );
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const { key, entry } = created.payload!;
      const scope = { agentId: "main", sessionKey: key, storePath };
      await appendTranscriptMessage(
        { ...scope, sessionId: entry.sessionId },
        {
          eventId: "recovery-input",
          parentId: null,
          message: { role: "user", content: "finish this work" },
        },
      );
      await upsertSessionEntryCore(scope, {
        status: "failed",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "required-recovery",
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      });
      const maintainer = ensureProfileForEmail("workspace-maintainer@example.test");
      cfg.gateway = undefined;
      const recovered = await recoverGatewaySession({
        cfg,
        getCurrentConfig: () => cfg,
        key,
        requestingOperatorProfileId: maintainer.id,
        actor: { type: "human", source: "profile", id: maintainer.id },
        workerPlacementContext: {},
        launchContinuation: async () => ({
          status: "rejected",
          error: { code: "UNAVAILABLE", message: "fixture does not launch a model" },
        }),
      });
      if (!recovered.ok) {
        throw new Error(recovered.error.message);
      }
      const successor = loadSessionEntry({ ...scope, sessionKey: recovered.successorKey })!;
      expect(successor).toMatchObject({
        createdActor: entry.createdActor,
        requiredWorkspace: entry.requiredWorkspace,
      });
      expect(successor.sandbox).toBe(sandbox);
      expect(successor.worktree?.id).not.toBe(entry.worktree?.id);
      expect(await requireGit(successor.sessionRoot!, ["rev-parse", "HEAD"])).toBe(
        await requireGit(workspace, ["rev-parse", "main"]),
      );
    });
  },
);

test("workspace alias changes during allocation revoke the selected source without publishing a row", async () => {
  await withSessionTestState({ layout: "state-only" }, async (state) => {
    const { workspace, storePath, cfg, context, client } = await fixture(state.root, true);
    const replacement = await initializeRepository(state.root, "replacement");
    expectDefined(
      cfg.gateway?.roles?.definitions.contributor?.sessions.workspace,
      "contributor workspace",
    ).projects = ["workspace:main"];
    cfg.agents = {
      ownership: "explicit",
      defaults: { workspace },
      entries: { main: { workspace } },
    };
    const allocate = managedWorktrees.createWithOutcome.bind(managedWorktrees);
    const changed = vi
      .spyOn(managedWorktrees, "createWithOutcome")
      .mockImplementation(async (params) => {
        cfg.agents = {
          ownership: "explicit",
          defaults: { workspace: replacement },
          entries: { main: { workspace: replacement } },
        };
        return await allocate(params);
      });
    const key = "agent:main:dashboard:changed-workspace-source";
    try {
      const result = await directSessionReq(
        "sessions.create",
        { key, projectId: "workspace:main" },
        { context, client },
      );
      expect(result.ok).toBe(false);
      expect(changed).toHaveBeenCalledOnce();
      expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
      expect(managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
    } finally {
      changed.mockRestore();
    }
  });
});

test("trusted visible isolated spawn retains its parent's workspace requirement after role removal", async () => {
  await withSessionTestState({ layout: "state-only" }, async (state) => {
    const { project, storePath, cfg, context, client } = await fixture(state.root, true);
    const parent = await directSessionReq<{ key: string; entry: SessionEntry }>(
      "sessions.create",
      { projectId: project.id },
      { context, client },
    );
    expect(parent.ok, JSON.stringify(parent.error)).toBe(true);
    cfg.gateway = undefined;
    const spawned = await directSessionReq<{ key: string; entry: SessionEntry }>(
      "sessions.create",
      { parentSessionKey: parent.payload!.key, spawnDepth: 1 },
      {
        context,
        client: createSyntheticPluginRuntimeClient({
          scopes: ["operator.write"],
          sessionCreation: {
            via: "spawn",
            actor: { type: "agent", id: "main" },
            requesterSessionKey: parent.payload!.key,
            inheritedToolPolicy: { version: 1, allow: ["read"], deny: [] },
          },
        }),
      },
    );
    expect(spawned.ok, JSON.stringify(spawned.error)).toBe(true);
    const entry = loadSessionEntry({
      agentId: "main",
      storePath,
      sessionKey: spawned.payload!.key,
    })!;
    expect(entry.requiredWorkspace).toEqual(parent.payload!.entry.requiredWorkspace);
    expect(entry.worktree?.id).not.toBe(parent.payload!.entry.worktree?.id);
  });
});

test("message-cut forks allocate a separate checkout from the required base", async () => {
  await withSessionTestState({ layout: "state-only" }, async (state) => {
    const { workspace, storePath, project, context, client } = await fixture(state.root, true);
    const created = await directSessionReq<{
      key: string;
      entry: SessionEntry;
      worktree: { id: string; path: string };
    }>("sessions.create", { projectId: project.id }, { context, client });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const { key, worktree } = created.payload!;
    const scope = { agentId: "main", storePath, sessionKey: key };
    const parent = loadSessionEntry(scope)!;
    await appendTranscriptMessage(
      { ...scope, sessionId: parent.sessionId },
      { eventId: "user-cut", parentId: null, message: { role: "user", content: "first request" } },
    );
    await requireGit(worktree.path, ["commit", "--allow-empty", "-m", "parent work"]);
    const forked = await directSessionReq<{ sessionKey: string }>(
      "sessions.fork",
      { sessionKey: key, entryId: "user-cut" },
      { context, client },
    );
    expect(forked.ok, JSON.stringify(forked.error)).toBe(true);
    const fork = loadSessionEntry({ ...scope, sessionKey: forked.payload!.sessionKey })!;
    expect(fork.worktree?.id).not.toBe(worktree.id);
    expect(fork.requiredWorkspace).toEqual(parent.requiredWorkspace);
    expect(await requireGit(fork.sessionRoot!, ["rev-parse", "HEAD"])).toBe(
      await requireGit(workspace, ["rev-parse", "main"]),
    );
  });
});

test("required workspace rejects absent or unauthorized selections and alternate path producers", async () => {
  await withSessionTestState({ layout: "state-only" }, async (state) => {
    const { workspace, storePath, project, context, client } = await fixture(state.root, true);
    for (const [index, selection] of [
      {},
      { projectId: "not-authorized" },
      { projectId: project.id, worktree: false },
      { projectId: project.id, cwd: workspace },
      { projectId: project.id, execNode: "another-node" },
      { projectId: project.id, worktree: true, worktreeBaseRef: "HEAD" },
      { projectId: project.id, incognito: true },
    ].entries()) {
      const key = `agent:main:dashboard:denied-workspace-${index}`;
      const response = await directSessionReq(
        "sessions.create",
        { key, ...selection },
        { context, client },
      );
      expect(response.ok, JSON.stringify(selection)).toBe(false);
      expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
      expect(managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
    }
    const key = "agent:main:dashboard:implicit-workspace";
    const patched = await directSessionReq(
      "sessions.patch",
      { key, label: "Implicit" },
      { context, client },
    );
    expect(patched).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
    const forged = await directSessionReq(
      "sessions.create",
      {
        projectId: project.id,
        requiredWorkspace: { projectId: project.id, worktreeBaseRef: "main" },
      },
      { context, client },
    );
    expect(forged).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });
});

test("allocation failure leaves no runnable session or first-turn dispatch", async () => {
  await withSessionTestState({ layout: "state-only" }, async (state) => {
    const { storePath, project, context, client } = await fixture(state.root, true);
    const key = "agent:main:dashboard:failed-workspace";
    const allocate = vi
      .spyOn(managedWorktrees, "createWithOutcome")
      .mockRejectedValue(new Error("checkout failed"));
    try {
      const response = await directSessionReq(
        "sessions.create",
        {
          key,
          projectId: project.id,
          task: "start after preparation",
        },
        { context, client },
      );
      expect(response.ok).toBe(false);
      expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
    } finally {
      allocate.mockRestore();
    }
  });
});

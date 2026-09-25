import fs from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { getRegistryWorktree, listRegistryWorktrees } from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  loadSessionEntry,
  onSessionIdentityMutation,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import {
  copyGitWorkspace,
  createGitWorkspace,
} from "./server.sessions.create.projects.test-support.js";
import {
  setupSessionCreateTestHarness,
  chatSendOwner,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import { sessionStoreEntry, directSessionReq } from "./test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

let gitWorkspaceTemplate: string;
const { createSessionStoreDir } = setupSessionCreateTestHarness(async (makeTempDir) => {
  gitWorkspaceTemplate = await createGitWorkspace(makeTempDir("openclaw-session-git-template-"));
});

test.each([false, true])(
  "sessions.create atomically persists trusted visible-spawn tool policy with required parent=%s",
  async (required) => {
    const { storePath } = await createSessionStoreDir();
    const parentSessionKey = "agent:main:main";
    const actor = { type: "human", source: "profile", id: "visible-spawn-creator" } as const;
    await writeSessionStore({
      entries: {
        [parentSessionKey]: {
          ...sessionStoreEntry("sess-visible-spawn-parent"),
          createdVia: "operator",
          createdActor: actor,
          ...(required ? { sandbox: "required" } : {}),
        },
      },
    });

    const created = await directSessionReq<{
      key?: string;
      entry?: {
        label?: string;
        spawnedBy?: string;
        completionOwnerSessionKey?: string;
        parentSessionKey?: string;
        spawnDepth?: number;
        inheritedToolPolicyVersion?: number;
        inheritedToolAllow?: string[];
        inheritedToolDeny?: string[];
      };
    }>(
      "sessions.create",
      {
        agentId: "main",
        label: "Restricted visible child",
        parentSessionKey,
        spawnDepth: 1,
      },
      {
        client: {
          connect: { scopes: ["operator.write"] },
          internal: {
            syntheticClient: true,
            operatorRoleActor: { kind: "system" },
            sessionCreation: {
              via: "spawn",
              actor: { type: "agent", id: "main" },
              requesterSessionKey: parentSessionKey,
              completionOwnerSessionKey: "agent:main:discord:direct:alice",
              inheritedToolPolicy: {
                version: 1,
                allow: ["read", "sessions_spawn"],
                deny: ["exec"],
              },
            },
          },
        } as never,
      },
    );

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
    expect(created.payload?.entry).toMatchObject({
      label: "Restricted visible child",
      spawnedBy: parentSessionKey,
      completionOwnerSessionKey: "agent:main:discord:direct:alice",
      parentSessionKey,
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "sessions_spawn"],
      inheritedToolDeny: ["exec"],
    });
    const key = requireNonEmptyString(created.payload?.key, "visible child key");
    const child = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(child).toMatchObject({
      spawnedBy: parentSessionKey,
      completionOwnerSessionKey: "agent:main:discord:direct:alice",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "sessions_spawn"],
      inheritedToolDeny: ["exec"],
      createdActor: required ? actor : { type: "agent", id: "main" },
    });
    expect(child?.sandbox).toBe(required ? "required" : undefined);
  },
);

test.each([false, true])(
  "sessions.create persists trusted agent-runtime spawn permissions with required parent=%s",
  async (required) => {
    const { storePath } = await createSessionStoreDir();
    const parentSessionKey = "agent:main:main";
    const actor = { type: "human", source: "profile", id: "runtime-spawn-creator" } as const;
    await writeSessionStore({
      entries: {
        [parentSessionKey]: {
          ...sessionStoreEntry("sess-runtime-spawn-parent"),
          createdVia: "operator",
          createdActor: actor,
          ...(required ? { sandbox: "required" } : {}),
        },
      },
    });

    const created = await directSessionReq<{
      key?: string;
      entry?: {
        createdVia?: string;
        createdActor?: unknown;
        spawnedBy?: string;
        completionOwnerSessionKey?: string;
        inheritedToolAllow?: string[];
        inheritedToolDeny?: string[];
      };
    }>(
      "sessions.create",
      {
        agentId: "main",
        label: "Runtime visible child",
        parentSessionKey,
        spawnDepth: 1,
      },
      {
        context: {
          // This fixture starts after authentication; token transport has its own tests.
          validateAgentRuntimeApprovalAuthority: () => true,
        },
        client: {
          connect: { scopes: ["operator.write"] },
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey: parentSessionKey,
              sessionSpawnContext: {
                completionOwnerSessionKey: "agent:main:discord:direct:bob",
                inheritedPermissionMode: "full",
                inheritedToolPolicy: {
                  version: 1,
                  allow: ["read", "sessions_spawn"],
                  deny: ["exec"],
                },
              },
            },
          },
        } as never,
      },
    );

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
    expect(created.payload?.entry).toMatchObject({
      createdVia: "spawn",
      createdActor: required ? actor : { type: "agent", id: "main" },
      spawnedBy: parentSessionKey,
      completionOwnerSessionKey: "agent:main:discord:direct:bob",
      permissionMode: "full",
      inheritedToolAllow: ["read", "sessions_spawn"],
      inheritedToolDeny: ["exec"],
    });
    const key = requireNonEmptyString(created.payload?.key, "runtime visible child key");
    const child = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(child).toMatchObject({
      spawnedBy: parentSessionKey,
      completionOwnerSessionKey: "agent:main:discord:direct:bob",
      permissionMode: "full",
      inheritedToolPolicyVersion: 1,
      createdActor: required ? actor : { type: "agent", id: "main" },
    });
    expect(child?.sandbox).toBe(required ? "required" : undefined);
  },
);

test("sessions.create rejects a replaced required spawn parent before child creation", async () => {
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:main";
  const childSessionKey = "agent:main:dashboard:replaced-parent-child";
  const parent = {
    ...sessionStoreEntry("required-spawn-parent"),
    lifecycleRevision: "original-parent",
    createdActor: { type: "human", source: "profile", id: "original-creator" } as const,
    sandbox: "required" as const,
  };
  await writeSessionStore({ entries: { [parentSessionKey]: parent } });
  const { createGatewaySession } = await import("./session-create-service.js");
  const parentMutationStarted = createDeferredCore();
  const replaceParent = createDeferredCore();
  const replacing = runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: [parentSessionKey, parent.sessionId],
    run: async () => {
      parentMutationStarted.resolve();
      await replaceParent.promise;
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: parentSessionKey, storePath },
        { ...parent, lifecycleRevision: "replacement-parent" },
      );
    },
  });
  await parentMutationStarted.promise;

  const creating = createGatewaySession({
    cfg: getRuntimeConfig(),
    agentId: "main",
    key: childSessionKey,
    parentSessionKey,
    spawnDepth: 1,
    commandSource: "test",
    creation: { via: "spawn", actor: { type: "agent", id: "main" } },
  });

  try {
    replaceParent.resolve();
    await replacing;
    const created = await creating;
    expect(created).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("changed before") },
    });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath }),
    ).toBeUndefined();
  } finally {
    replaceParent.resolve();
    await Promise.allSettled([replacing, creating]);
  }
});

test("sessions.create commits no session after delegated authority closes", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:authority-race";
  let authorityCurrent = true;
  const firstGuard = createDeferredCore();
  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const heldWriter = runExclusiveSqliteSessionWrite(
    resolveSqliteStoreScope(storePath, { agentId: "main" }),
    async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    },
    "session.transcript.batch",
  );
  await writerEntered.promise;

  const creating = directSessionReq(
    "sessions.create",
    { agentId: "main", key: sessionKey },
    {
      context: {
        validateAgentRuntimeApprovalAuthority: () => {
          firstGuard.resolve();
          return authorityCurrent;
        },
      },
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:main",
          },
        },
      } as never,
    },
  );

  try {
    await firstGuard.promise;
    authorityCurrent = false;
    releaseWriter.resolve();
    await heldWriter;

    const created = await creating;
    expect(created.ok).toBe(false);
    expect(created.error?.message).toContain("agent runtime authority is no longer active");
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
  } finally {
    releaseWriter.resolve();
    await Promise.allSettled([heldWriter, creating]);
  }
});

test("sessions.create commits no child after its bound Gateway is replaced", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:gateway-replacement-race";
  const admitted = {};
  const replacement = {};
  let current = admitted;
  const firstGuard = createDeferredCore();
  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const resolvedStore = resolveSqliteStoreScope(storePath, { agentId: "main" });
  const heldWriter = runExclusiveSqliteSessionWrite(
    resolvedStore,
    async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    },
    "session.transcript.batch",
  );
  await writerEntered.promise;
  const creating = directSessionReq(
    "sessions.create",
    { agentId: "main", key: sessionKey },
    {
      sessionMutationAuthorization: {
        assertCurrent: () => {
          if (current !== admitted) {
            throw new Error("current gateway instance binding was replaced");
          }
          firstGuard.resolve();
        },
        assertTargetCurrent: vi.fn(),
      },
    },
  );

  try {
    await firstGuard.promise;
    current = replacement;
    releaseWriter.resolve();
    await heldWriter;

    await expect(creating).rejects.toThrow("current gateway instance binding was replaced");
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
  } finally {
    releaseWriter.resolve();
    await Promise.allSettled([heldWriter, creating]);
  }
});

test("sessions.create commits no child after its worker turn closes", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:worker-turn-race";
  const database = openOpenClawStateDatabase();
  const placements = createWorkerSessionPlacementStore({ database });
  let placement = placements.startDispatch({
    agentId: "main",
    sessionId: "worker-source-session",
    sessionKey: "agent:main:dashboard:worker-source",
  });
  seedAttachedPlacementEnvironment(database, {
    environmentId: "worker-environment",
    sessionId: placement.sessionId,
    ownerEpoch: 7,
  });
  for (const [from, to, patch] of [
    ["requested", "provisioning", { environmentId: "worker-environment" }],
    ["provisioning", "syncing", { workerBundleHash: "a".repeat(64) }],
    [
      "syncing",
      "starting",
      { remoteWorkspaceDir: "/workspace/source", workspaceBaseManifestRef: "manifest-source" },
    ],
    ["starting", "active", { activeOwnerEpoch: 7 }],
  ] as const) {
    placement = placements.transition({
      sessionId: placement.sessionId,
      from,
      to,
      expectedGeneration: placement.generation,
      patch,
    });
  }
  const turnClaim = placements.claimTurn({
    agentId: placement.agentId,
    sessionId: placement.sessionId,
    sessionKey: placement.sessionKey,
    claimId: "worker-claim",
    runId: "worker-run",
    owner: { kind: "worker", environmentId: "worker-environment", ownerEpoch: 7 },
  });
  const firstGuard = createDeferredCore();
  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const heldWriter = runExclusiveSqliteSessionWrite(
    resolveSqliteStoreScope(storePath, { agentId: "main" }),
    async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    },
    "session.transcript.batch",
  );
  await writerEntered.promise;
  const creating = directSessionReq(
    "sessions.create",
    { agentId: "main", key: sessionKey },
    {
      sessionMutationAuthorization: {
        assertCurrent: () => {
          if (!placements.validateTurnClaim(turnClaim)) {
            throw new Error("worker turn authority changed");
          }
          firstGuard.resolve();
        },
        assertTargetCurrent: vi.fn(),
      },
    },
  );

  try {
    await firstGuard.promise;
    placements.releaseTurn(turnClaim);
    releaseWriter.resolve();
    await heldWriter;

    await expect(creating).rejects.toThrow("worker turn authority changed");
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
  } finally {
    releaseWriter.resolve();
    await Promise.allSettled([heldWriter, creating]);
  }
});

test("sessions.create starts no initial turn when authority closes after session commit", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:authority-post-commit";
  const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  chatSend.mockImplementation(async ({ respond }) => {
    respond(true, { runId: "must-not-start", status: "started" });
  });
  let authorityCurrent = true;
  let committedSessionId: string | undefined;
  const unsubscribe = onSessionIdentityMutation((mutation) => {
    if (mutation.kind === "create" && mutation.current.sessionKeys.includes(sessionKey)) {
      committedSessionId = loadSessionEntry({ sessionKey, storePath })?.sessionId;
      authorityCurrent = false;
    }
  });

  try {
    const created = await directSessionReq<{ sessionId?: string; runStarted?: boolean }>(
      "sessions.create",
      { agentId: "main", key: sessionKey, message: "do not launch after closure" },
      {
        context: {
          validateAgentRuntimeApprovalAuthority: () => authorityCurrent,
        },
        client: {
          connect: { scopes: ["operator.write"] },
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
          },
        } as never,
      },
    );

    expect(created.ok).toBe(true);
    expect(created.payload?.runStarted).toBe(false);
    expect(chatSend).not.toHaveBeenCalled();
    const sessionId = requireNonEmptyString(created.payload?.sessionId, "committed session id");
    expect(committedSessionId).toBe(sessionId);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
  } finally {
    unsubscribe();
    chatSend.mockRestore();
  }
});

test("sessions.create removes a provisioned worktree when authority closes before session commit", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-authority-worktree-",
  });
  const workspace = await copyGitWorkspace(gitWorkspaceTemplate, openClawState.root);
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:authority-worktree-cleanup";
  let authorityCurrent = true;
  let allocatedWorktree: { id: string; path: string } | undefined;
  let allocatedDirectoryExists = false;
  const createWorktree = managedWorktrees.createWithOutcome.bind(managedWorktrees);
  const createSpy = vi
    .spyOn(managedWorktrees, "createWithOutcome")
    .mockImplementation(async (params) => {
      const outcome = await createWorktree(params);
      allocatedWorktree = outcome.record;
      allocatedDirectoryExists = (await fs.stat(outcome.record.path)).isDirectory();
      authorityCurrent = false;
      return outcome;
    });

  try {
    const created = await directSessionReq(
      "sessions.create",
      {
        agentId: "main",
        key: sessionKey,
        worktree: true,
        worktreeName: "authority-cleanup",
      },
      {
        context: {
          validateAgentRuntimeApprovalAuthority: () => authorityCurrent,
        },
        client: {
          connect: { scopes: ["operator.admin"] },
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
          },
        } as never,
      },
    );

    expect(created.ok).toBe(false);
    expect(created.error?.message).toContain("agent runtime authority is no longer active");
    const worktreeId = requireNonEmptyString(allocatedWorktree?.id, "allocated worktree id");
    const worktreePath = requireNonEmptyString(allocatedWorktree?.path, "allocated worktree path");
    expect(allocatedDirectoryExists).toBe(true);
    expect(getRegistryWorktree(process.env, worktreeId)).toMatchObject({
      removedAt: expect.any(Number),
    });
    await expect(fs.stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(
      listRegistryWorktrees(process.env).filter(
        (record) => record.ownerKind === "session" && record.removedAt === undefined,
      ),
    ).toEqual([]);
  } finally {
    createSpy.mockRestore();
    await disposeSessionReadContexts();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create rejects a trusted spawn whose parent differs from its agent caller", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq(
    "sessions.create",
    {
      agentId: "main",
      parentSessionKey: "agent:main:other",
      spawnDepth: 1,
    },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:main",
            sessionSpawnContext: {
              inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] },
            },
          },
        },
      } as never,
    },
  );

  expect(created.ok).toBe(false);
  expect(created.error?.message).toContain("spawn parent must match the trusted agent caller");
});

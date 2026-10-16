import fs from "node:fs/promises";
import { expect, test, vi } from "vitest";
import type { SessionsCreateResult } from "../../packages/gateway-protocol/src/index.js";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  getRegistryWorktree,
  listRegistryWorktrees,
} from "../agents/worktrees/registry.test-support.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
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
import type { AgentRuntimeSessionSpawnContext } from "./agent-runtime-session-spawn-context.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import {
  copyGitWorkspace,
  createGitWorkspace,
} from "./server.sessions.create.projects.test-support.js";
import {
  setupSessionCreateHandlerTestHarness,
  chatSendOwner,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import * as sessionStoreWorker from "./session-utils-store-worker.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import { sessionStoreEntry, directSessionReq } from "./test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "./worker-environments/placement-test-fixtures.js";

let gitWorkspaceTemplate: string;
const { createSessionStoreDir } = setupSessionCreateHandlerTestHarness(async (makeTempDir) => {
  gitWorkspaceTemplate = await createGitWorkspace(makeTempDir("openclaw-session-git-template-"));
});

const parentSessionKey = "agent:main:main";
const inheritedToolPolicy: AgentRuntimeSessionSpawnContext["inheritedToolPolicy"] = {
  version: 1,
  allow: ["read", "sessions_spawn"],
  deny: ["exec"],
};

function runtimeClient(
  sessionSpawnContext?: AgentRuntimeSessionSpawnContext,
  scope = "operator.write",
) {
  // These handler fixtures start after authentication; token transport has its own tests.
  return {
    connect: { scopes: [scope] },
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: parentSessionKey,
        sessionSpawnContext,
      },
    },
  } as never;
}

function createSession(
  params: Record<string, unknown>,
  options?: Parameters<typeof directSessionReq>[2],
) {
  return directSessionReq<SessionsCreateResult>(
    "sessions.create",
    { agentId: "main", ...params },
    options,
  );
}

async function seedSpawnParent(id: string, sandbox?: "required") {
  const { storePath } = await createSessionStoreDir();
  const actor = { type: "human", source: "profile", id: `${id}-creator` } as const;
  await writeSessionStore({
    entries: {
      [parentSessionKey]: {
        ...sessionStoreEntry(`sess-${id}-parent`),
        createdVia: "operator",
        createdActor: actor,
        ...(sandbox ? { sandbox } : {}),
      },
    },
  });
  return { storePath, actor };
}

async function holdSessionWriter(storePath: string) {
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
  return { releaseWriter, heldWriter };
}

test.each(["visible-spawn", "runtime-spawn"] as const)(
  "sessions.create persists trusted %s policy",
  async (source) => {
    const runtime = source === "runtime-spawn";
    const { storePath, actor } = await seedSpawnParent(source, runtime ? undefined : "required");
    const label = runtime ? "Runtime visible child" : "Restricted visible child";
    const completionOwnerSessionKey = `agent:main:discord:direct:${runtime ? "bob" : "alice"}`;
    const spawnContext = { completionOwnerSessionKey, inheritedToolPolicy };
    const created = await createSession(
      { label, parentSessionKey, spawnDepth: 1 },
      runtime
        ? {
            context: { validateAgentRuntimeApprovalAuthority: () => true },
            client: runtimeClient({ ...spawnContext, inheritedPermissionMode: "full" }),
          }
        : {
            client: {
              connect: { scopes: ["operator.write"] },
              internal: {
                syntheticClient: true,
                operatorRoleActor: { kind: "system" },
                sessionCreation: {
                  ...spawnContext,
                  via: "spawn",
                  actor: { type: "agent", id: "main" },
                  requesterSessionKey: parentSessionKey,
                },
              },
            } as never,
          },
    );
    const policy = {
      spawnedBy: parentSessionKey,
      completionOwnerSessionKey,
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "sessions_spawn"],
      inheritedToolDeny: ["exec"],
      ...(runtime ? { permissionMode: "full", createdActor: { type: "agent", id: "main" } } : {}),
    };
    expect(created, JSON.stringify(created.error)).toMatchObject({
      ok: true,
      payload: {
        key: expect.stringMatching(/^agent:main:dashboard:/),
        entry: {
          ...policy,
          ...(runtime ? { createdVia: "spawn" } : { label, parentSessionKey, spawnDepth: 1 }),
        },
      },
    });
    const key = requireNonEmptyString(created.payload?.key, "visible child key");
    const child = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(child).toMatchObject({
      ...policy,
      createdActor: runtime ? { type: "agent", id: "main" } : actor,
    });
    expect(child?.sandbox).toBe(runtime ? undefined : "required");
  },
);

test("sessions.create rejects a replaced required spawn parent before child creation", async () => {
  const { storePath } = await createSessionStoreDir();
  const childSessionKey = "agent:main:dashboard:replaced-parent-child";
  const parent = {
    ...sessionStoreEntry("required-spawn-parent"),
    lifecycleRevision: "original-parent",
  };
  await writeSessionStore({ entries: { [parentSessionKey]: parent } });
  const { createGatewaySession } = await import("./session-create-service.js");
  const parentMutationStarted = createDeferredCore();
  const replaceParent = createDeferredCore();
  const replacing = runExclusiveSessionLifecycleMutation("create", {
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

  const lifecycleAdmission = createDeferredCore();
  const creating = createGatewaySession({
    cfg: getRuntimeConfig(),
    agentId: "main",
    key: childSessionKey,
    parentSessionKey,
    spawnDepth: 1,
    commandSource: "test",
    creation: { via: "spawn", actor: { type: "agent", id: "main" } },
    onPhase: (phase) => {
      if (phase === "lifecycleAdmission") {
        lifecycleAdmission.resolve();
      }
    },
  });

  try {
    await awaitGateBeforeSettlement(
      lifecycleAdmission.promise,
      creating,
      "Session creation settled before lifecycle admission",
    );
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

test("sessions.create commits no child after its worker turn closes", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:worker-turn-race";
  const database = openOpenClawStateDatabase();
  const placements = createWorkerSessionPlacementStore({ database });
  const placement = await advancePlacementFixtureToActive(
    placements,
    database,
    {
      agentId: "main",
      sessionId: "worker-source-session",
      sessionKey: "agent:main:dashboard:worker-source",
    },
    {
      environmentId: "worker-environment",
      ownerEpoch: 7,
    },
  );
  const turnClaim = await placements.claimTurn({
    agentId: placement.agentId,
    sessionId: placement.sessionId,
    sessionKey: placement.sessionKey,
    claimId: "worker-claim",
    runId: "worker-run",
    owner: { kind: "worker", environmentId: "worker-environment", ownerEpoch: 7 },
  });
  const context = {};
  const listed = await directSessionReq("sessions.list", {}, { context });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  const readStarted = createDeferredCore();
  const readEntry = sessionStoreWorker.loadGatewaySessionEntryReadOnlyInWorker;
  using lookup = vi.spyOn(sessionStoreWorker, "loadGatewaySessionEntryReadOnlyInWorker");
  lookup.mockImplementation((input) => {
    const reading = readEntry(input);
    readStarted.resolve();
    return reading;
  });
  const { releaseWriter, heldWriter } = await holdSessionWriter(storePath);
  const creating = createSession(
    { key: sessionKey },
    {
      context,
      sessionMutationAuthorization: {
        assertCurrent: () => {
          if (!placements.validateTurnClaim(turnClaim)) {
            throw new Error("worker turn authority changed");
          }
        },
        assertTargetCurrent: vi.fn(),
      },
    },
  );

  const rejected = expect(creating).rejects.toThrow("worker turn authority changed");

  try {
    await awaitGateBeforeSettlement(readStarted.promise, creating, "Session read was not queued");
    await placements.releaseTurn(turnClaim);
    releaseWriter.resolve();
    await heldWriter;

    await rejected;
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
  } finally {
    releaseWriter.resolve();
    await Promise.allSettled([heldWriter, creating]);
  }
});

test("sessions.create starts no initial turn when authority closes after session commit", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:authority-post-commit";
  using chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  chatSend.mockImplementation(async ({ respond }) => {
    respond(true, { runId: "must-not-start", status: "started" });
  });
  let authorityCurrent = true;
  let committedSessionId: string | undefined;
  using _ = {
    [Symbol.dispose]: onSessionIdentityMutation((mutation) => {
      if (mutation.kind === "create" && mutation.current.sessionKeys.includes(sessionKey)) {
        committedSessionId = loadSessionEntry({ sessionKey, storePath })?.sessionId;
        authorityCurrent = false;
      }
    }),
  };

  const created = await createSession(
    { key: sessionKey, message: "do not launch after closure" },
    {
      context: {
        validateAgentRuntimeApprovalAuthority: () => authorityCurrent,
      },
      client: runtimeClient(),
    },
  );

  expect(created).toMatchObject({ ok: true, payload: { runStarted: false } });
  expect(chatSend).not.toHaveBeenCalled();
  const sessionId = requireNonEmptyString(created.payload?.sessionId, "committed session id");
  expect(committedSessionId).toBe(sessionId);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
});

test.each(["queued", "worktree"] as const)(
  "sessions.create commits no session after %s authority closes",
  async (phase) => {
    const openClawState =
      phase === "worktree"
        ? await createOpenClawTestState({
            layout: "state-only",
            prefix: "openclaw-session-authority-worktree-",
          })
        : undefined;
    if (openClawState) {
      testState.agentConfig = {
        workspace: await copyGitWorkspace(gitWorkspaceTemplate, openClawState.root),
      };
    }
    const { storePath } = await createSessionStoreDir();
    const sessionKey = `agent:main:dashboard:authority-${openClawState ? "worktree-cleanup" : "race"}`;
    let authorityCurrent = true;
    const firstGuard = createDeferredCore();
    const context = {
      validateAgentRuntimeApprovalAuthority: () => {
        firstGuard.resolve();
        return authorityCurrent;
      },
    };
    let allocatedWorktree: { id: string; path: string } | undefined;
    let allocatedDirectoryExists = false;
    const createWorktree = captureMethodCall("createWithOutcome")(ManagedWorktreeService.prototype);
    using createSpy = openClawState
      ? vi
          .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
          .mockImplementation(async function (this: ManagedWorktreeService, params) {
            const outcome = await createWorktree(this, params);
            allocatedWorktree = outcome.record;
            allocatedDirectoryExists = (await fs.stat(outcome.record.path)).isDirectory();
            authorityCurrent = false;
            return outcome;
          })
      : undefined;
    if (!openClawState) {
      const listed = await directSessionReq("sessions.list", {}, { context });
      expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    }
    const writer = openClawState ? undefined : await holdSessionWriter(storePath);
    const creating = createSession(
      {
        key: sessionKey,
        ...(openClawState ? { worktree: true, worktreeName: "authority-cleanup" } : {}),
      },
      {
        context,
        client: runtimeClient(undefined, openClawState ? "operator.admin" : "operator.write"),
      },
    );

    try {
      if (writer) {
        await firstGuard.promise;
        authorityCurrent = false;
        writer.releaseWriter.resolve();
        await writer.heldWriter;
      }
      const created = await creating;
      expect(created.ok).toBe(false);
      expect(created.error?.message).toContain("agent runtime authority is no longer active");
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
      if (openClawState) {
        const worktreeId = requireNonEmptyString(allocatedWorktree?.id, "allocated worktree id");
        const worktreePath = requireNonEmptyString(
          allocatedWorktree?.path,
          "allocated worktree path",
        );
        expect(allocatedDirectoryExists).toBe(true);
        expect(getRegistryWorktree(process.env, worktreeId)).toMatchObject({
          removedAt: expect.any(Number),
        });
        await expect(fs.stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          listRegistryWorktrees(process.env).filter(
            (record) => record.ownerKind === "session" && record.removedAt === undefined,
          ),
        ).toEqual([]);
      }
    } finally {
      writer?.releaseWriter.resolve();
      await Promise.allSettled([writer?.heldWriter, creating]);
      createSpy?.mockRestore();
      if (openClawState) {
        await disposeSessionReadContexts();
        testState.agentConfig = undefined;
        await openClawState.cleanup();
      }
    }
  },
);

test("sessions.create rejects a trusted spawn whose parent differs from its agent caller", async () => {
  await createSessionStoreDir();

  const created = await createSession(
    {
      parentSessionKey: "agent:main:other",
      spawnDepth: 1,
    },
    {
      client: runtimeClient({
        inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] },
      }),
    },
  );

  expect(created.ok).toBe(false);
  expect(created.error?.message).toContain("spawn parent must match the trusted agent caller");
});

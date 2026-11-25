import { expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  setupSessionCreateHandlerTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import * as sessionStoreWorker from "./session-utils-store-worker.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  directSessionReq,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

const { createSessionStoreDir } = setupSessionCreateHandlerTestHarness();

type CreatedSessionPayload = { key?: string; entry?: SessionEntry };

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

test.each([
  { drafts: true, fork: false },
  { drafts: true, fork: true },
  { drafts: false, fork: false },
  { drafts: false, fork: true },
])(
  "sessions.create applies Draft spawn policy (draft selection=$drafts, fork=$fork)",
  async ({ drafts, fork }) => {
    testState.sessionConfig = { sharing: { drafts } };
    const { storePath } = await createSessionStoreDir();
    const parentSessionKey = "agent:main:main";
    const actor = { type: "human", source: "profile", id: "visible-spawn-creator" } as const;
    await writeSessionStore({
      entries: {
        [parentSessionKey]: {
          ...sessionStoreEntry("sess-visible-spawn-parent"),
          createdVia: "operator",
          createdActor: actor,
          sandbox: "required",
          visibility: "draft",
        },
      },
    });
    if (fork) {
      await seedSessionTranscript({
        agentId: "main",
        sessionId: "sess-visible-spawn-parent",
        sessionKey: parentSessionKey,
        storePath,
        messages: [
          { role: "user", content: "Synthetic picnic planning context" },
          { role: "assistant", content: "We can plan around the weather.", stopReason: "stop" },
        ],
      });
    }
    const childSessionKey = "agent:main:dashboard:draft-spawn";

    const created = await directSessionReq<CreatedSessionPayload>(
      "sessions.create",
      {
        agentId: "main",
        key: childSessionKey,
        label: "Restricted visible child",
        parentSessionKey,
        spawnDepth: 1,
        fork,
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

    if (!drafts) {
      expect(created).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringContaining("Continue in the existing Draft"),
          details: { code: "SESSION_VISIBILITY_DISABLED", visibility: "draft" },
        },
      });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath }),
      ).toBeUndefined();
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: parentSessionKey, storePath }),
      ).toMatchObject({
        sessionId: "sess-visible-spawn-parent",
        visibility: "draft",
      });
      const explicitShared = await directSessionReq<CreatedSessionPayload>("sessions.create", {
        agentId: "main",
        parentSessionKey,
        visibility: "shared",
      });
      expect(explicitShared.ok, JSON.stringify(explicitShared.error)).toBe(true);
      expect(explicitShared.payload?.entry?.visibility).toBe("shared");
      return;
    }
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
      visibility: "draft",
    });
    const key = requireNonEmptyString(created.payload?.key, "visible child key");
    const child = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(child).toMatchObject({
      spawnedBy: parentSessionKey,
      completionOwnerSessionKey: "agent:main:discord:direct:alice",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "sessions_spawn"],
      inheritedToolDeny: ["exec"],
      createdActor: actor,
    });
    expect(child?.sandbox).toBe("required");
    expect(child?.visibility).toBe("draft");
    if (fork) {
      expect(
        await loadTranscriptEvents({
          agentId: "main",
          sessionKey: key,
          sessionId: requireNonEmptyString(child?.sessionId, "forked child session id"),
          storePath,
        }),
      ).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: "Synthetic picnic planning context" }),
        }),
      );
    }
    const explicitShared = await directSessionReq<CreatedSessionPayload>("sessions.create", {
      agentId: "main",
      parentSessionKey,
      visibility: "shared",
    });
    expect(explicitShared.ok, JSON.stringify(explicitShared.error)).toBe(true);
    expect(explicitShared.payload?.entry?.visibility).toBe("shared");
    const publishedParent = await directSessionReq("session.visibility.set", {
      sessionKey: parentSessionKey,
      visibility: "shared",
    });
    expect(publishedParent.ok, JSON.stringify(publishedParent.error)).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.visibility).toBe(
      "draft",
    );
  },
);

test("sessions.create rechecks inherited Draft admission after spawn preparation", async () => {
  const { createGatewaySession } = await import("./session-create-service.js");
  testState.sessionConfig = { sharing: { drafts: true } };
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:main";
  const key = "agent:main:dashboard:draft-policy-changed";
  await writeSessionStore({
    entries: {
      [parentSessionKey]: {
        ...sessionStoreEntry("draft-policy-parent"),
        visibility: "draft",
      },
    },
  });
  const cfg = getRuntimeConfig();
  let currentConfig = cfg;
  let prepared = false;
  const created = await createGatewaySession({
    cfg,
    getCurrentConfig: () => currentConfig,
    agentId: "main",
    key,
    parentSessionKey,
    spawnDepth: 1,
    commandSource: "test",
    creation: { via: "spawn", actor: { type: "agent", id: "main" } },
    onPhase: (phase) => {
      if (phase === "worktree") {
        prepared = true;
        currentConfig = { ...cfg, session: { ...cfg.session, sharing: { drafts: false } } };
      }
    },
  });
  expect(prepared).toBe(true);
  expect(created).toMatchObject({
    ok: false,
    error: { details: { code: "SESSION_VISIBILITY_DISABLED", visibility: "draft" } },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: parentSessionKey, storePath }),
  ).toMatchObject({
    sessionId: "draft-policy-parent",
    visibility: "draft",
  });
});

test("sessions.create persists trusted agent-runtime spawn permissions", async () => {
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:main";
  const actor = { type: "human", source: "profile", id: "runtime-spawn-creator" } as const;
  await writeSessionStore({
    entries: {
      [parentSessionKey]: {
        ...sessionStoreEntry("sess-runtime-spawn-parent"),
        createdVia: "operator",
        createdActor: actor,
      },
    },
  });

  const created = await directSessionReq<CreatedSessionPayload>(
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
    createdActor: { type: "agent", id: "main" },
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
    createdActor: { type: "agent", id: "main" },
  });
  expect(child?.sandbox).toBeUndefined();
  expect(child?.visibility ?? "shared").toBe("shared");
});

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
  const replacing = runSessionMutation({
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
  let placement = await placements.startDispatch({
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
    placement = await placements.transition({
      sessionId: placement.sessionId,
      from,
      to,
      expectedGeneration: placement.generation,
      patch,
    });
  }
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
  const lookup = vi
    .spyOn(sessionStoreWorker, "loadGatewaySessionEntryReadOnlyInWorker")
    .mockImplementation((input) => {
      const reading = readEntry(input);
      readStarted.resolve();
      return reading;
    });
  const { releaseWriter, heldWriter } = await holdSessionWriter(storePath);
  const creating = directSessionReq(
    "sessions.create",
    { agentId: "main", key: sessionKey },
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
    lookup.mockRestore();
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

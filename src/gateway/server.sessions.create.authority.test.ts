import { expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import * as sessionMembers from "../config/sessions/session-sharing-store.native.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  setUserProfileRole,
} from "../state/user-profiles.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "./session-sharing.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  createCompactedSessionFixture,
  sessionStoreEntry,
  directSessionReq,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupSessionCreateTestHarness();

test("required operator sandbox follows new session ownership across create, patch, and patchMany", async () => {
  const { storePath } = await createSessionStoreDir();

  const cfg = {
    ...getRuntimeConfig(),
    session: { ...getRuntimeConfig().session, store: storePath },
    gateway: {
      ...getRuntimeConfig().gateway,
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" as const },
            agents: ["main"],
            scopes: ["operator.read" as const, "operator.write" as const],
            sandbox: "required" as const,
          },
        },
      },
    },
  };
  const context = { getRuntimeConfig: () => cfg };

  for (const [method, suffix, systemActor] of [
    ["sessions.create", "create", false],
    ["sessions.patch", "patch", false],
    ["sessions.patchMany", "patch-many", false],
    ["sessions.create", "owner-create", true],
    ["sessions.patch", "owner-patch", true],
    ["sessions.patchMany", "owner-patch-many", true],
  ] as const) {
    const profile = systemActor
      ? ensureGatewayOwnerProfile("Gateway Owner")
      : ensureProfileForEmail(`sandboxed-session-${suffix}@example.com`);
    if (!systemActor) {
      setUserProfileRole(profile.id, "guest");
    }
    const client = {
      ...(systemActor ? { internal: { operatorRoleActor: { kind: "system" } } } : {}),
      connect: { role: "operator", scopes: ["operator.read", "operator.write"] },
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: profile.displayName,
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      },
    } as never;
    const key = `agent:main:dashboard:role-sandbox-${suffix}`;
    const request =
      method === "sessions.create"
        ? { agentId: "main", key }
        : method === "sessions.patch"
          ? { key, label: `Guest session ${suffix}` }
          : { patch: { label: `Guest session ${suffix}` }, targets: [{ key }] };

    const created = await directSessionReq<{ outcomes?: Array<{ ok: boolean }> }>(method, request, {
      client,
      context,
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    if (method === "sessions.patchMany") {
      expect(created.payload?.outcomes).toEqual([{ ok: true, key }]);
    }
    const createdEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(createdEntry).toMatchObject({
      createdActor: { type: "human", source: "profile", id: profile.id },
    });
    expect(createdEntry?.sandbox).toBe(systemActor ? undefined : "required");

    for (const forgedSandbox of [null, "inherit"] as const) {
      const forged = await directSessionReq(
        "sessions.patch",
        { key, sandbox: forgedSandbox },
        { client, context },
      );

      expect(forged).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.sandbox).toBe(
      systemActor ? undefined : "required",
    );
  }
});

test("operator role agent allowlists protect creation without blocking existing sessions", async () => {
  const { storePath } = await createSessionStoreDir();
  const profile = ensureProfileForEmail("restricted-session-creator@example.com");
  setUserProfileRole(profile.id, "guest");
  const cfg = {
    ...getRuntimeConfig(),
    session: { ...getRuntimeConfig().session, store: storePath },
    gateway: {
      ...getRuntimeConfig().gateway,
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" as const },
            agents: ["guest-only"],
            scopes: ["operator.read" as const, "operator.write" as const],
          },
        },
      },
    },
  };
  const client = {
    connect: { role: "operator", scopes: ["operator.read", "operator.write"] },
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: profile.displayName,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    },
  } as never;
  const requestOptions = { client, context: { getRuntimeConfig: () => cfg } };
  const deniedKey = "agent:main:dashboard:role-denied";

  const created = await directSessionReq(
    "sessions.create",
    { agentId: "main", key: deniedKey },
    requestOptions,
  );
  expect(created).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: expect.stringContaining('agent "main"') },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: deniedKey, storePath })).toBeUndefined();

  const patched = await directSessionReq(
    "sessions.patch",
    { key: deniedKey, label: "bypass attempt" },
    requestOptions,
  );
  expect(patched).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

  const patchedMany = await directSessionReq<{ outcomes: Array<{ ok: boolean; error?: unknown }> }>(
    "sessions.patchMany",
    { patch: { label: "bulk bypass attempt" }, targets: [{ key: deniedKey }] },
    requestOptions,
  );
  expect(patchedMany).toMatchObject({
    ok: true,
    payload: { outcomes: [{ ok: false, error: { code: "FORBIDDEN" } }] },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: deniedKey, storePath })).toBeUndefined();

  const existingKey = "agent:main:dashboard:role-existing";
  await writeSessionStore({
    entries: {
      [existingKey]: sessionStoreEntry("role-existing-session", {
        createdActor: { type: "human", source: "profile", id: profile.id },
      }),
    },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: existingKey, storePath })).toMatchObject({
    sessionId: "role-existing-session",
  });
  expect(
    resolveGatewaySessionStoreTarget({ cfg, key: existingKey, agentId: "main" }).storePath,
  ).toBe(storePath);
  const adopted = await directSessionReq(
    "sessions.create",
    { agentId: "main", key: existingKey },
    requestOptions,
  );
  expect(adopted.ok).toBe(true);
  const existingPatch = await directSessionReq(
    "sessions.patch",
    { key: existingKey, label: "still allowed" },
    requestOptions,
  );
  expect(existingPatch.ok).toBe(true);
});

test("sessions.create carries keyed adoption authorization through the durable commit", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:categorized-adoption";
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("session-categorized-adoption", { category: "Personal" }),
    },
  });
  const assertCurrent = vi.fn();

  const adopted = await directSessionReq(
    "sessions.create",
    { agentId: "main", key, category: "Projects" },
    {
      sessionMutationAuthorization: {
        assertCurrent,
        assertTargetCurrent: vi.fn(),
      },
    },
  );

  expect(adopted.ok).toBe(true);
  expect(assertCurrent).toHaveBeenCalled();
  expect(loadSessionEntry({ sessionKey: key, storePath })?.category).toBe("Projects");
});

test("sessions.create revalidates parent participation before committing a fork transcript", async () => {
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:dashboard:participation-race-parent";
  const parentSessionId = "participation-race-parent-session";
  const childSessionKey = "agent:main:dashboard:participation-race-child";
  await writeSessionStore({
    entries: {
      [parentSessionKey]: sessionStoreEntry(parentSessionId, {
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "owner" },
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: parentSessionId,
    sessionKey: parentSessionKey,
    storePath,
    messages: [{ role: "user", content: "private parent context" }],
  });
  sessionMembers.addSessionMember(
    { agentId: "main", sessionKey: parentSessionKey, storePath },
    { identityId: "member", addedBy: "owner", expectedSessionId: parentSessionId },
  );
  const client = {
    authenticatedUserId: "member@example.com",
    authenticatedUserProfile: {
      profileId: "member",
      displayName: "Member",
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: { role: "operator", scopes: ["operator.write"] },
  } as never;
  const requestParams = {
    agentId: "main",
    key: childSessionKey,
    parentSessionKey,
    fork: true,
  };
  const authorization = resolveSessionMutationAuthorization({
    client,
    method: "sessions.create",
    requestParams,
    context: { getRuntimeConfig } as never,
  });
  expect(authorization.error).toBeNull();
  const assertCurrent = authorization.authorization?.assertCurrent;
  if (!assertCurrent) {
    throw new Error("sessions.create did not capture parent participation");
  }

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
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    ...(resolvedStore.path ? { path: resolvedStore.path } : {}),
  });
  const transcriptCount = () =>
    (
      database.db.prepare("SELECT count(*) AS count FROM transcript_events").get() as {
        count: number;
      }
    ).count;
  const beforeTranscriptCount = transcriptCount();
  const firstGuard = createDeferredCore();
  let guardCalls = 0;
  const { createGatewaySession } = await import("./session-create-service.js");
  const creating = createGatewaySession({
    cfg: getRuntimeConfig(),
    ...requestParams,
    commandSource: "test",
    commitGuard: () => {
      assertCurrent();
      guardCalls += 1;
      if (guardCalls === 1) {
        firstGuard.resolve();
      }
    },
  });

  try {
    await firstGuard.promise;
    sessionMembers.removeSessionMember(
      { agentId: "main", sessionKey: parentSessionKey, storePath },
      "member",
      undefined,
      parentSessionId,
    );
  } finally {
    releaseWriter.resolve();
    await heldWriter;
  }

  await expect(creating).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath }),
  ).toBeUndefined();
  expect(transcriptCount()).toBe(beforeTranscriptCount);
});

test("createGatewaySession rejects explicit and key-derived unconfigured creation owners", async () => {
  const { createGatewaySession } = await import("./session-create-service.js");
  const cfg = { agents: { entries: { ops: { default: true } } } };
  const prepareLifecycle = vi.fn();

  for (const { owner, message } of [
    { owner: { agentId: "main" }, message: 'Unknown agent id "main"' },
    {
      owner: { key: "agent:main:dashboard:unconfigured-owner" },
      message: 'Unknown agent id "main"',
    },
    { owner: { agentId: "   " }, message: 'Unknown agent id "   "' },
  ]) {
    await expect(
      createGatewaySession({ cfg, ...owner, commandSource: "test", prepareLifecycle }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message },
    });
  }

  expect(prepareLifecycle).not.toHaveBeenCalled();
});

test("sessions.create gives plugin runtimes an owned root without linking operator sessions", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: sessionStoreEntry("operator-owned-main") },
  });
  const pluginClient = {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  const created = await directSessionReq<{
    key: string;
    entry: { parentSessionKey?: string; pluginOwnerId?: string };
  }>("sessions.create", { agentId: "main" }, { client: pluginClient });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const key = requireNonEmptyString(created.payload?.key, "plugin-owned root session key");
  expect(created.payload?.entry).toMatchObject({ pluginOwnerId: "memory-core" });
  expect(created.payload?.entry.parentSessionKey).toBeUndefined();
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    pluginOwnerId: "memory-core",
  });

  const patched = await directSessionReq(
    "sessions.patch",
    { key, label: "Plugin-owned root" },
    { client: pluginClient },
  );

  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    label: "Plugin-owned root",
    pluginOwnerId: "memory-core",
  });
});

test("sessions.create prevents plugin runtimes from adopting, linking, or forking foreign sessions", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:dashboard:foreign-owned": sessionStoreEntry("foreign-session", {
        pluginOwnerId: "other-plugin",
      }),
      "agent:main:dashboard:operator-owned": sessionStoreEntry("operator-session"),
    },
  });
  const pluginClient = {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  for (const { name, params, action, target } of [
    {
      name: "forking a foreign plugin transcript",
      params: { parentSessionKey: "agent:main:dashboard:foreign-owned", fork: true },
      action: "fork",
      target: "agent:main:dashboard:foreign-owned",
    },
    {
      name: "linking a foreign plugin parent",
      params: { parentSessionKey: "agent:main:dashboard:foreign-owned" },
      action: "link",
      target: "agent:main:dashboard:foreign-owned",
    },
    {
      name: "forking an operator-owned transcript",
      params: { parentSessionKey: "agent:main:dashboard:operator-owned", fork: true },
      action: "fork",
      target: "agent:main:dashboard:operator-owned",
    },
    {
      name: "adopting a foreign plugin session",
      params: { key: "agent:main:dashboard:foreign-owned" },
      action: "adopt",
      target: "agent:main:dashboard:foreign-owned",
    },
    {
      name: "adopting an operator-owned session",
      params: { key: "agent:main:dashboard:operator-owned" },
      action: "adopt",
      target: "agent:main:dashboard:operator-owned",
    },
  ]) {
    const created = await directSessionReq("sessions.create", params, { client: pluginClient });

    expect(created.ok, name).toBe(false);
    expect(created.error, name).toMatchObject({
      code: "INVALID_REQUEST",
      message: `Plugin "memory-core" cannot ${action} session "${target}" because it did not create it.`,
    });
    expect(loadSessionEntry({ sessionKey: target, storePath })).toBeDefined();
  }
});

test("sessions.create allows plugin runtimes to link their own parent session", async () => {
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:dashboard:memory-core-parent";
  await writeSessionStore({
    entries: {
      [parentSessionKey]: sessionStoreEntry("memory-core-parent", {
        pluginOwnerId: "memory-core",
      }),
    },
  });
  const pluginClient = {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  const created = await directSessionReq<{
    key: string;
    entry: { parentSessionKey?: string };
  }>("sessions.create", { parentSessionKey }, { client: pluginClient });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry.parentSessionKey).toBe(parentSessionKey);
  expect(loadSessionEntry({ sessionKey: parentSessionKey, storePath })?.pluginOwnerId).toBe(
    "memory-core",
  );
});

test("public session mutations reserve agent harness-owned session keys", async () => {
  const { storePath } = await createSessionStoreDir();

  for (const key of [
    "harness:codex:supervision:native-thread",
    "agent:main:harness:codex:supervision:native-thread",
  ]) {
    for (const [method, params] of [
      ["sessions.create", { agentId: "main", key }],
      ["sessions.patch", { agentId: "main", key, label: "Public overwrite" }],
      ["sessions.reset", { agentId: "main", key }],
    ] as const) {
      const rejected = await directSessionReq(method, params);
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "Session key namespace is reserved for agent harness-owned sessions.",
      });
    }
  }

  const ordinary = await directSessionReq<{ key: string }>("sessions.create", {
    agentId: "main",
    key: "ordinary-session",
  });
  expect(ordinary.ok).toBe(true);
  expect(ordinary.payload?.key).toBe("agent:main:ordinary-session");

  expect(
    loadSessionEntry({
      sessionKey: "agent:main:harness:codex:supervision:native-thread",
      storePath,
    }),
  ).toBeUndefined();
  expect(loadSessionEntry({ sessionKey: "agent:main:ordinary-session", storePath })).toBeDefined();
});

test("sessions.create preserves a pre-existing unlocked harness-prefixed session", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:harness:legacy-notes";
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("legacy-session", { label: "Legacy notes" }),
    },
  });

  const created = await directSessionReq<{
    key: string;
    sessionId: string;
  }>("sessions.create", {
    agentId: "main",
    key,
    label: "Updated notes",
  });

  expect(created.ok).toBe(true);
  expect(created.payload).toMatchObject({ key, sessionId: "legacy-session" });
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    sessionId: "legacy-session",
    label: "Updated notes",
  });
});

test("sessions.create rejects a pre-existing locked harness session", async () => {
  await createSessionStoreDir();
  const key = "agent:main:harness:codex:supervision:native-thread";
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("locked-session", {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }),
    },
  });

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    key,
  });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "Session key namespace is reserved for agent harness-owned sessions.",
  });
});

test("sessions.create rejects children of model-selection-locked sessions", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main", scope: "per-sender" };
  const parent = await createCompactedSessionFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        modelSelectionLocked: true,
      }),
    },
  });

  const linkedChild = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
  });
  const forkedChild = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    fork: true,
  });
  const resetParent = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
  });

  for (const created of [linkedChild, forkedChild, resetParent]) {
    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Model-selection-locked sessions cannot create child sessions from parent context.",
    });
  }
  testState.sessionConfig = undefined;
});

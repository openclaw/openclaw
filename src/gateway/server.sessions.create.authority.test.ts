import { expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import * as sessionMembers from "../config/sessions/session-sharing-store.native.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  createCompactedSessionFixture,
  sessionStoreEntry,
  directSessionReq,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupSessionCreateTestHarness();

async function createStore() {
  const store = await createSessionStoreDir();
  return {
    ...store,
    read: (sessionKey: string, agentId?: string) =>
      loadSessionEntry({ storePath: store.storePath, sessionKey, agentId }),
    seed: (key: string, id: string, entry?: Parameters<typeof sessionStoreEntry>[1]) =>
      writeSessionStore({ entries: { [key]: sessionStoreEntry(id, entry) } }),
  };
}

function guestConfig(storePath: string, role: Partial<GatewayOperatorRoleDefinition>) {
  const cfg = getRuntimeConfig();
  const guest: GatewayOperatorRoleDefinition = {
    sessions: { others: "view" },
    agents: ["main"],
    scopes: ["operator.read", "operator.write"],
    ...role,
  };
  return {
    ...cfg,
    session: { ...cfg.session, store: storePath },
    gateway: {
      ...cfg.gateway,
      roles: { default: "guest", definitions: { guest } },
    },
  };
}

function authenticatedProfile(profileId: string, displayName: string | null, updatedAt: number) {
  return { profileId, displayName, hasAvatar: false, updatedAt };
}

function operatorClient(profile: ReturnType<typeof ensureProfileForEmail>, systemActor = false) {
  return {
    ...(systemActor ? { internal: { operatorRoleActor: { kind: "system" } } } : {}),
    connect: { role: "operator", scopes: ["operator.read", "operator.write"] },
    authenticatedUserProfile: authenticatedProfile(
      profile.id,
      profile.displayName,
      profile.updatedAt,
    ),
  } as never;
}

function pluginClient() {
  return {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;
}
const reservedNamespace = "Session key namespace is reserved for agent harness-owned sessions.";
const harnessKey = "agent:main:harness:codex:supervision:native-thread";
function expectInvalid(
  result: Awaited<ReturnType<typeof directSessionReq>>,
  message = reservedNamespace,
) {
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", message } });
}

function sessionRequests(
  options: Omit<NonNullable<Parameters<typeof directSessionReq>[2]>, "coercePayload">,
) {
  return <T = unknown>(
    method: Parameters<typeof directSessionReq>[0],
    params: Record<string, unknown>,
  ): ReturnType<typeof directSessionReq<T>> => directSessionReq<T>(method, params, options);
}

async function expectOk(request: ReturnType<typeof directSessionReq>) {
  expect((await request).ok).toBe(true);
}

test("required operator sandbox follows new session ownership across create, patch, and patchMany", async () => {
  const { storePath, read } = await createStore();
  const cfg = guestConfig(storePath, { sandbox: "required" });
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
    const req = sessionRequests({ client: operatorClient(profile, systemActor), context });
    const key = `agent:main:dashboard:role-sandbox-${suffix}`;
    const request =
      method === "sessions.create"
        ? { agentId: "main", key }
        : method === "sessions.patch"
          ? { key, label: `Guest session ${suffix}` }
          : { patch: { label: `Guest session ${suffix}` }, targets: [{ key }] };

    const created = await req<{ outcomes?: Array<{ ok: boolean }> }>(method, request);

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    if (method === "sessions.patchMany") {
      expect(created.payload?.outcomes).toEqual([{ ok: true, key }]);
    }
    const createdEntry = read(key, "main");
    expect(createdEntry?.createdActor).toMatchObject({
      type: "human",
      source: "profile",
      id: profile.id,
    });
    expect(createdEntry?.sandbox).toBe(systemActor ? undefined : "required");

    for (const forgedSandbox of [null, "inherit"] as const) {
      await expect(req("sessions.patch", { key, sandbox: forgedSandbox })).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    }
    expect(read(key, "main")?.sandbox).toBe(systemActor ? undefined : "required");
  }
});

test("operator role agent allowlists protect creation without blocking existing sessions", async () => {
  const { storePath, read, seed } = await createStore();
  const profile = ensureProfileForEmail("restricted-session-creator@example.com");
  setUserProfileRole(profile.id, "guest");
  const cfg = guestConfig(storePath, { agents: ["guest-only"] });
  const client = operatorClient(profile);
  const req = sessionRequests({ client, context: { getRuntimeConfig: () => cfg } });
  const deniedKey = "agent:main:dashboard:role-denied";

  const created = await req("sessions.create", { agentId: "main", key: deniedKey });
  expect(created).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: expect.stringContaining('agent "main"') },
  });
  expect(read(deniedKey, "main")).toBeUndefined();

  await expect(
    req("sessions.patch", { key: deniedKey, label: "bypass attempt" }),
  ).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

  await expect(
    req("sessions.patchMany", {
      patch: { label: "bulk bypass attempt" },
      targets: [{ key: deniedKey }],
    }),
  ).resolves.toMatchObject({
    ok: true,
    payload: { outcomes: [{ ok: false, error: { code: "FORBIDDEN" } }] },
  });
  expect(read(deniedKey, "main")).toBeUndefined();

  const existingKey = "agent:main:dashboard:role-existing";
  await seed(existingKey, "role-existing-session", {
    createdActor: { type: "human", source: "profile", id: profile.id },
  });
  expect(read(existingKey, "main")).toMatchObject({ sessionId: "role-existing-session" });
  expect(
    (await resolveGatewaySessionStoreTargetInWorker({ cfg, key: existingKey, agentId: "main" }))
      .storePath,
  ).toBe(storePath);
  await expectOk(req("sessions.create", { agentId: "main", key: existingKey }));
  await expectOk(req("sessions.patch", { key: existingKey, label: "still allowed" }));
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
  const { storePath, read, seed } = await createStore();
  const parentKey = "agent:main:dashboard:participation-race-parent";
  const parentId = "participation-race-parent-session";
  const childKey = "agent:main:dashboard:participation-race-child";
  const parentScope = { agentId: "main", sessionKey: parentKey, storePath };
  await seed(parentKey, parentId, {
    visibility: "read-only",
    createdActor: { type: "human", source: "profile", id: "owner" },
  });
  await seedSessionTranscript({
    ...parentScope,
    sessionId: parentId,
    messages: [{ role: "user", content: "private parent context" }],
  });
  sessionMembers.addSessionMember(parentScope, {
    identityId: "member",
    addedBy: "owner",
    expectedSessionId: parentId,
  });
  const client = {
    authenticatedUserId: "member@example.com",
    authenticatedUserProfile: authenticatedProfile("member", "Member", 1),
    connect: { role: "operator", scopes: ["operator.write"] },
  } as never;
  const requestParams = { agentId: "main", key: childKey, parentSessionKey: parentKey, fork: true };
  const authorization = await resolveSessionMutationAuthorizationAsync({
    client,
    method: "sessions.create",
    requestParams,
    context: { getRuntimeConfig } as never,
  });
  using _ = { [Symbol.dispose]: () => authorization.authorization?.release?.() };
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
  const countTranscripts = database.db.prepare("SELECT count(*) AS count FROM transcript_events");
  const transcriptCount = () => (countTranscripts.get() as { count: number }).count;
  const beforeTranscriptCount = transcriptCount();
  const firstGuard = createDeferredCore();
  const { createGatewaySession } = await import("./session-create-service.js");
  const creating = createGatewaySession({
    cfg: getRuntimeConfig(),
    ...requestParams,
    commandSource: "test",
    commitGuard: () => {
      assertCurrent();
      firstGuard.resolve();
    },
  });

  try {
    await firstGuard.promise;
    sessionMembers.removeSessionMember(parentScope, "member", undefined, parentId);
  } finally {
    releaseWriter.resolve();
    await heldWriter;
  }

  await expect(creating).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
  expect(read(childKey, "main")).toBeUndefined();
  expect(transcriptCount()).toBe(beforeTranscriptCount);
});

test("createGatewaySession rejects explicit and key-derived unconfigured creation owners", async () => {
  const { createGatewaySession } = await import("./session-create-service.js");
  const cfg = { agents: { ownership: "explicit" as const, entries: { ops: {} } } };
  const prepareLifecycle = vi.fn();

  for (const [owner, agentId] of [
    [{ agentId: "main" }, "main"],
    [{ key: "agent:main:dashboard:unconfigured-owner" }, "main"],
    [{ agentId: "   " }, "   "],
    [{ parentSessionKey: "agent:retired:main" }, "retired"],
    [{ agentId: "   ", parentSessionKey: "agent:ops:main" }, "   "],
  ] as const) {
    expectInvalid(
      await createGatewaySession({ cfg, ...owner, commandSource: "test", prepareLifecycle }),
      `Unknown agent id "${agentId}"`,
    );
  }

  expect(prepareLifecycle).not.toHaveBeenCalled();
});

test.each([undefined, "agent:main:dashboard:memory-core-parent"])(
  "sessions.create gives plugin runtimes owned sessions with parent %s",
  async (parentSessionKey) => {
    const { read, seed } = await createStore();
    const req = sessionRequests({ client: pluginClient() });
    await seed(
      parentSessionKey ?? "main",
      parentSessionKey ? "memory-core-parent" : "operator-owned-main",
      parentSessionKey ? { pluginOwnerId: "memory-core" } : undefined,
    );
    const created = await req<{
      key: string;
      entry: { parentSessionKey?: string; pluginOwnerId?: string };
    }>("sessions.create", parentSessionKey ? { parentSessionKey } : { agentId: "main" });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.entry.parentSessionKey).toBe(parentSessionKey);
    if (parentSessionKey) {
      expect(read(parentSessionKey)?.pluginOwnerId).toBe("memory-core");
      return;
    }
    const key = requireNonEmptyString(created.payload?.key, "plugin-owned root session key");
    expect(created.payload?.entry).toMatchObject({ pluginOwnerId: "memory-core" });
    expect(read(key)).toMatchObject({ pluginOwnerId: "memory-core" });

    await expectOk(req("sessions.patch", { key, label: "Plugin-owned root" }));
    expect(read(key)).toMatchObject({ label: "Plugin-owned root", pluginOwnerId: "memory-core" });
  },
);

test("sessions.create prevents plugin runtimes from adopting, linking, or forking foreign sessions", async () => {
  const { read } = await createStore();
  const req = sessionRequests({ client: pluginClient() });
  await writeSessionStore({
    entries: {
      "agent:main:dashboard:foreign-owned": sessionStoreEntry("foreign-session", {
        pluginOwnerId: "other-plugin",
      }),
      "agent:main:dashboard:operator-owned": sessionStoreEntry("operator-session"),
    },
  });
  for (const [action, suffix] of [
    ["fork", "foreign-owned"],
    ["link", "foreign-owned"],
    ["fork", "operator-owned"],
    ["adopt", "foreign-owned"],
    ["adopt", "operator-owned"],
  ]) {
    const target = `agent:main:dashboard:${suffix}`;
    const params =
      action === "adopt"
        ? { key: target }
        : { parentSessionKey: target, ...(action === "fork" ? { fork: true } : {}) };
    expectInvalid(
      await req("sessions.create", params),
      `Plugin "memory-core" cannot ${action} session "${target}" because it did not create it.`,
    );
    expect(read(target)).toBeDefined();
  }
});

test("public session mutations reserve agent harness-owned session keys", async () => {
  const { read } = await createStore();

  for (const key of ["harness:codex:supervision:native-thread", harnessKey]) {
    for (const [method, params] of [
      ["sessions.create", { agentId: "main", key }],
      ["sessions.patch", { agentId: "main", key, label: "Public overwrite" }],
      ["sessions.reset", { agentId: "main", key }],
    ] as const) {
      expectInvalid(await directSessionReq(method, params));
    }
  }

  const ordinary = await directSessionReq("sessions.create", {
    agentId: "main",
    key: "ordinary-session",
  });
  expect(ordinary).toMatchObject({ ok: true, payload: { key: "agent:main:ordinary-session" } });
  expect(read(harnessKey)).toBeUndefined();
  expect(read("agent:main:ordinary-session")).toBeDefined();
});

test.each([false, true])(
  "sessions.create adopts existing harness sessions only when unlocked (locked=%s)",
  async (locked) => {
    const { read, seed } = await createStore();
    const key = locked ? harnessKey : "agent:main:harness:legacy-notes";
    await seed(
      key,
      locked ? "locked-session" : "legacy-session",
      locked ? { agentHarnessId: "codex", modelSelectionLocked: true } : { label: "Legacy notes" },
    );

    const created = await directSessionReq("sessions.create", {
      agentId: "main",
      key,
      ...(locked ? {} : { label: "Updated notes" }),
    });

    if (locked) {
      expectInvalid(created);
      return;
    }
    expect(created).toMatchObject({ ok: true, payload: { key, sessionId: "legacy-session" } });
    expect(read(key)).toMatchObject({ sessionId: "legacy-session", label: "Updated notes" });
  },
);

test("sessions.create rejects children of model-selection-locked sessions", async () => {
  const { dir, seed } = await createStore();
  testState.sessionConfig = { dmScope: "main", scope: "per-sender" };
  const parent = await createCompactedSessionFixture(dir);
  await seed("main", parent.sessionId, {
    sessionFile: parent.sessionFile,
    modelSelectionLocked: true,
  });

  for (const options of [{}, { fork: true }, { emitCommandHooks: true }]) {
    expectInvalid(
      await directSessionReq("sessions.create", {
        agentId: "main",
        parentSessionKey: "main",
        ...options,
      }),
      "Model-selection-locked sessions cannot create child sessions from parent context.",
    );
  }
  testState.sessionConfig = undefined;
});

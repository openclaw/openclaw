import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, test, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteStoreScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import * as sessionMembers from "../config/sessions/session-sharing-store.native.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  dashboardTitleScheduleMocks,
  setupSessionCreateTestHarness,
} from "./server.sessions.create.test-support.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";
import { getGatewayConfigModule, sessionStoreEntry } from "./test/server-sessions.test-helpers.js";

// Hold the real worker command before SQLite starts writing; every command and
// native receipt still comes from the production owner, including on refusal.
const replacementBoundary = vi.hoisted(() => ({
  key: undefined as string | undefined,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));
vi.mock(
  "../config/sessions/session-accessor.sqlite-replacement-worker.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../config/sessions/session-accessor.sqlite-replacement-worker.js")
      >();
    return {
      ...actual,
      commitSessionEntryReplacementsInWorker: async (
        ...args: Parameters<typeof actual.commitSessionEntryReplacementsInWorker>
      ) => {
        if (args[2].replacements.some(({ sessionKey }) => sessionKey === replacementBoundary.key)) {
          replacementBoundary.entered?.();
          await replacementBoundary.release;
        }
        return await actual.commitSessionEntryReplacementsInWorker(...args);
      },
    };
  },
);

const { createSessionStoreDir } = setupSessionCreateTestHarness();
afterEach(() => {
  replacementBoundary.key = undefined;
  replacementBoundary.entered = undefined;
  replacementBoundary.release = undefined;
});

async function createFixture(
  suffix: string,
  targetFields: Partial<SessionEntry> = {},
  communication?: SessionEntry["communication"],
) {
  const { dir, storePath } = await createSessionStoreDir();
  const creator = ensureProfileForEmail("communication-creator-" + suffix + "@example.test");
  const collaborator = ensureProfileForEmail(
    "communication-collaborator-" + suffix + "@example.test",
  );
  const admin = ensureProfileForEmail("communication-admin-" + suffix + "@example.test");
  for (const profile of [creator, collaborator]) {
    setUserProfileRole(profile.id, "collaborator");
  }
  setUserProfileRole(admin.id, "administrator");
  const cfg = {
    ...getRuntimeConfig(),
    session: { ...getRuntimeConfig().session, store: storePath, communication },
    gateway: {
      ...getRuntimeConfig().gateway,
      roles: {
        default: "collaborator",
        definitions: {
          collaborator: {
            sessions: { others: "view" as const },
            agents: ["main"],
            scopes: ["operator.read" as const, "operator.write" as const],
          },
          administrator: {
            sessions: { others: "write" as const },
            agents: ["main"],
            scopes: ["operator.admin" as const],
          },
        },
      },
    },
  };
  const parentKey = "agent:main:dashboard:communication-parent-" + suffix;
  const targetKey = "agent:main:dashboard:communication-target-" + suffix;
  const creatorActor = { type: "human", source: "profile", id: creator.id } as const;
  await writeSessionStore({
    entries: {
      [parentKey]: sessionStoreEntry("communication-parent-" + suffix, {
        createdActor: creatorActor,
        visibility: "read-only",
        communication: { receive: "always" },
      }),
      [targetKey]: sessionStoreEntry("communication-target-" + suffix, {
        createdActor: creatorActor,
        visibility: "read-only",
        communication: { receive: "never" },
        ...targetFields,
      }),
    },
  });
  for (const key of [parentKey, targetKey]) {
    sessionMembers.addSessionMember(
      { agentId: "main", sessionKey: key, storePath },
      {
        identityId: collaborator.id,
        addedBy: creator.id,
        expectedSessionId: expectDefined(
          loadSessionEntry({ sessionKey: key, storePath }),
          "seeded session",
        ).sessionId,
      },
    );
  }
  dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
  const makeContext = async () => {
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    context.readPreparedGatewayModelCatalog = async () => {
      const catalog = await context.loadGatewayModelCatalogSnapshot();
      return { entries: catalog.entries, routeVariants: catalog.routeVariants };
    };
    await initializeSessionReadContext(context);
    return context;
  };
  const creatorClient = identifiedClient(creator.id);
  const collaboratorClient = identifiedClient(collaborator.id);
  const adminClient = identifiedClient(admin.id);
  adminClient.connect.scopes = ["operator.admin"];
  return {
    dir,
    storePath,
    creator,
    collaborator,
    parentKey,
    targetKey,
    creatorClient,
    collaboratorClient,
    adminClient,
    context: await makeContext(),
    makeContext,
  };
}

// The suite WS connector supports shared credentials, not selected profile
// authentication. Use its real RPC router: directSessionReq calls core handlers
// directly and would skip the creator/admin check this regression must prove.
async function request(
  context: GatewayRequestContext,
  client: GatewayClient,
  method: string,
  params: Record<string, unknown>,
) {
  const responses: Parameters<RespondFn>[] = [];
  await handleGatewayRequest({
    req: { type: "req", id: "communication-" + method, method, params },
    client,
    context,
    isWebchatConnect: () => false,
    respond: (...response) => responses.push(response),
  });
  await flushPendingSessionsChangedEvents(context);
  expect(responses).toHaveLength(1);
  const [ok, payload, error] = responses[0]!;
  return { ok, payload, error };
}

test("sessions.create inherits communication for a new explicit child, not an adopted collaborator target", async () => {
  const f = await createFixture("adoption");
  const childKey = "agent:main:dashboard:communication-new-child";
  const child = await request(f.context, f.collaboratorClient, "sessions.create", {
    agentId: "main",
    key: childKey,
    parentSessionKey: f.parentKey,
  });
  expect(child.ok, JSON.stringify(child.error)).toBe(true);
  expect(child.payload).toMatchObject({
    key: childKey,
    entry: { parentSessionKey: f.parentKey, communication: { receive: "always" } },
  });
  expect(loadSessionEntry({ sessionKey: childKey, storePath: f.storePath })).toMatchObject({
    parentSessionKey: f.parentKey,
    communication: { receive: "always" },
    createdActor: { type: "human", id: f.collaborator.id },
  });

  const before = expectDefined(
    loadSessionEntry({ sessionKey: f.targetKey, storePath: f.storePath }),
    "existing target",
  );
  const adopted = await request(f.context, f.collaboratorClient, "sessions.create", {
    agentId: "main",
    key: f.targetKey,
    parentSessionKey: f.parentKey,
    label: "Adopted without changing communication",
  });
  expect(adopted.ok, JSON.stringify(adopted.error)).toBe(true);
  expect(adopted.payload).toMatchObject({ key: f.targetKey, sessionId: before.sessionId });
  const after = expectDefined(
    loadSessionEntry({ sessionKey: f.targetKey, storePath: f.storePath }),
    "adopted target",
  );
  // Parent linkage and the label prove that the existing-row write reached the
  // old inherited spread, rather than being denied or returning a cached ACK.
  expect(after).toMatchObject({
    sessionId: before.sessionId,
    parentSessionKey: f.parentKey,
    label: "Adopted without changing communication",
    createdActor: before.createdActor,
  });
  expect(after.communication?.receive).toBe("never");
  expect(adopted.payload).toMatchObject({ entry: { communication: { receive: "never" } } });
});

test("communication writes require the creator or admin and existing creates cannot overwrite policy", async () => {
  const f = await createFixture("explicit");
  for (const method of ["sessions.create", "sessions.patch"] as const) {
    const denied = await request(f.context, f.collaboratorClient, method, {
      key: f.targetKey,
      communication: { receive: "always" },
    });
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "Only the session creator or an admin can change communication settings.",
      },
    });
    expect(
      loadSessionEntry({ sessionKey: f.targetKey, storePath: f.storePath })?.communication,
    ).toEqual({
      receive: "never",
    });
  }
  const overwrite = await request(f.context, f.creatorClient, "sessions.create", {
    key: f.targetKey,
    communication: { receive: "always" },
  });
  expect(overwrite).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "sessions.create communication requires a new session",
    },
  });
  for (const client of [f.creatorClient, f.adminClient]) {
    const receive = client === f.creatorClient ? "ask" : "never";
    const allowed = await request(f.context, client, "sessions.patch", {
      key: f.targetKey,
      communication: { receive },
    });
    expect(allowed.ok, JSON.stringify(allowed.error)).toBe(true);
    expect(
      loadSessionEntry({ sessionKey: f.targetKey, storePath: f.storePath })?.communication,
    ).toEqual({
      receive,
    });
  }

  const beforeReset = expectDefined(
    loadSessionEntry({ sessionKey: f.targetKey, storePath: f.storePath }),
    "target before reset",
  );
  const reset = await request(f.context, f.adminClient, "sessions.reset", { key: f.targetKey });
  expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
  const resetEntry = expectDefined(
    loadSessionEntry({ sessionKey: f.targetKey, storePath: f.storePath }),
    "reset target",
  );
  expect(resetEntry.communication).toEqual({ receive: "never" });
  expect(resetEntry.sessionId).toBe(beforeReset.sessionId);
  expect(resetEntry.lifecycleRevision).not.toBe(beforeReset.lifecycleRevision);

  // Retire projection/readers and real SQLite workers through the fixture owner,
  // then read the same candidate database through fresh RPC state.
  await disposeSessionReadContexts();
  await releaseGatewaySessionStoreFixture(f.dir);
  testState.sessionStorePath = f.storePath;
  (await getGatewayConfigModule()).clearRuntimeConfigSnapshot();
  const reopened = await f.makeContext();
  const described = await request(reopened, identifiedClient(f.creator.id), "sessions.describe", {
    key: f.targetKey,
  });
  expect(described.ok, JSON.stringify(described.error)).toBe(true);
  expect(described.payload).toMatchObject({
    session: { sessionId: resetEntry.sessionId, communication: { receive: "never" } },
  });
  expect(
    loadSessionEntry({ sessionKey: f.targetKey, storePath: f.storePath })?.communication,
  ).toEqual({
    receive: "never",
  });
});

test.each([
  {
    name: "built-in defaults",
    defaults: undefined,
    effective: { send: "always", receive: "always" },
  },
  {
    name: "configured defaults",
    defaults: { send: "never", receive: "ask" },
    effective: { send: "never", receive: "ask" },
  },
] as const)(
  "preserves pre-feature sparse metadata with $name through RPC and SQLite reopen",
  async ({ name, defaults, effective }) => {
    const metadata = {
      label: "Existing conversation",
      icon: "book",
      category: "Compatibility",
      sidebarRoot: true,
    };
    const f = await createFixture(
      name.replaceAll(" ", "-"),
      { ...metadata, communication: undefined },
      defaults,
    );
    const scope = { sessionKey: f.targetKey, storePath: f.storePath };
    const before = expectDefined(loadSessionEntry(scope), "pre-feature stored row");
    expect(before).not.toHaveProperty("communication");

    const described = await request(f.context, f.creatorClient, "sessions.describe", {
      key: f.targetKey,
    });
    expect(described.ok, JSON.stringify(described.error)).toBe(true);
    expect(described.payload).toMatchObject({
      session: { ...metadata, sessionId: before.sessionId, effectiveCommunication: effective },
    });
    // Describing a sparse row projects defaults without backfilling stored overrides.
    expect(loadSessionEntry(scope)).toEqual(before);
    expect(loadSessionEntry(scope)).not.toHaveProperty("communication");

    const patched = await request(f.context, f.creatorClient, "sessions.patch", {
      key: f.targetKey,
      expectedSessionId: before.sessionId,
      communication: { send: "ask" },
    });
    expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
    const expected = {
      ...metadata,
      sessionId: before.sessionId,
      createdActor: before.createdActor,
      communication: { send: "ask" },
    };
    expect(loadSessionEntry(scope)).toMatchObject(expected);
    expect(loadSessionEntry(scope)?.communication).toEqual({ send: "ask" });

    await disposeSessionReadContexts();
    await releaseGatewaySessionStoreFixture(f.dir);
    testState.sessionStorePath = f.storePath;
    (await getGatewayConfigModule()).clearRuntimeConfigSnapshot();
    const reopened = await f.makeContext();
    const reloaded = await request(reopened, identifiedClient(f.creator.id), "sessions.describe", {
      key: f.targetKey,
    });
    expect(reloaded.ok, JSON.stringify(reloaded.error)).toBe(true);
    expect(reloaded.payload).toMatchObject({
      session: {
        ...expected,
        createdActor: { type: "human", id: f.creator.id },
        effectiveCommunication: { send: "ask", receive: effective.receive },
      },
    });
    expect(loadSessionEntry(scope)).toMatchObject(expected);
    expect(loadSessionEntry(scope)?.communication).toEqual({ send: "ask" });
  },
);

test.for(["creator", "admin", "membership"] as const)(
  "sessions.create refuses persistence after %s authority changes during worker preparation",
  async (authority, { signal }) => {
    const f = await createFixture("revoked-" + authority);
    const childKey =
      authority === "creator"
        ? f.targetKey
        : "agent:main:dashboard:communication-revoked-child-" + authority;
    const client =
      authority === "creator"
        ? f.creatorClient
        : authority === "admin"
          ? f.adminClient
          : f.collaboratorClient;
    const parent = { agentId: "main", sessionKey: f.parentKey, storePath: f.storePath };
    const resolved = resolveSqliteStoreScope(f.storePath, { agentId: "main" });
    const database = openOpenClawAgentDatabase({ agentId: "main", path: resolved.path });
    const transcriptCount = () =>
      database.db.prepare("SELECT count(*) AS count FROM transcript_events").get()?.count;
    const beforeTranscripts = transcriptCount();
    const entered = createDeferred();
    const release = createDeferred();
    replacementBoundary.key = childKey;
    replacementBoundary.entered = entered.resolve;
    replacementBoundary.release = release.promise;
    const creating = request(f.context, client, "sessions.create", {
      agentId: "main",
      key: childKey,
      parentSessionKey: f.parentKey,
      // Revoke the creator of an existing protected target; creating a new child
      // from a still-accessible parent does not require owning that parent.
      ...(authority === "creator" ? { label: "must-not-commit" } : {}),
      // Membership exercises omitted policy inheritance through actual access.
      ...(authority === "membership" ? {} : { communication: { receive: "never" } }),
    });
    const settled = creating.then(
      (response) => ({ response, error: undefined }),
      (error: unknown) => ({ response: undefined, error }),
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          creating,
          "creation never reached the real SQLite replacement",
        ),
        signal,
      );
      if (authority === "creator") {
        // Creator attribution is immutable; retire the actual human connection.
        client.invalidated = true;
      } else if (authority === "admin") {
        client.connect.scopes = ["operator.read", "operator.write"];
      } else {
        sessionMembers.removeSessionMember(
          parent,
          f.collaborator.id,
          undefined,
          expectDefined(loadSessionEntry(parent), "current parent").sessionId,
        );
      }
    } finally {
      release.resolve();
      await settled;
    }
    const outcome = await settled;
    if (authority === "creator") {
      // A disconnected transport cannot receive a denial response.
      expect(outcome.error).toMatchObject({ message: "Gateway requester authority changed" });
    } else {
      expect(outcome.error).toBeUndefined();
      const denied = expectDefined(outcome.response, "live transport refusal");
      expect(denied.ok).toBe(false);
      expect(denied.error).toMatchObject(
        authority === "membership"
          ? { code: "INVALID_REQUEST", details: { code: "SESSION_PARTICIPATION_REQUIRED" } }
          : { code: "FORBIDDEN", message: "Gateway requester authority changed" },
      );
    }
    const persisted = loadSessionEntry({ sessionKey: childKey, storePath: f.storePath });
    if (authority === "creator") {
      expect(persisted?.communication).toEqual({ receive: "never" });
      expect(persisted?.label).toBeUndefined();
    } else {
      expect(persisted).toBeUndefined();
    }
    expect(transcriptCount()).toBe(beforeTranscripts);
    expect(loadSessionEntry(parent)?.communication).toEqual({ receive: "always" });
  },
);

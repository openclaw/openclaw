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

// Pause before the real SQLite write; keep production commands and receipts.
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
  const makeProfile = (role: string) => ensureProfileForEmail(`${role}-${suffix}@example.test`);
  const creator = makeProfile("creator");
  const collaborator = makeProfile("collaborator");
  const admin = makeProfile("admin");
  for (const profile of [creator, collaborator]) {
    setUserProfileRole(profile.id, "collaborator");
  }
  setUserProfileRole(admin.id, "administrator");
  const base = getRuntimeConfig();
  const role = (
    others: "view" | "write",
    scopes: ("operator.read" | "operator.write" | "operator.admin")[],
  ) => ({ sessions: { others }, agents: ["main"], scopes });
  const cfg = {
    ...base,
    session: { ...base.session, store: storePath, communication },
    gateway: {
      ...base.gateway,
      roles: {
        default: "collaborator",
        definitions: {
          collaborator: role("view", ["operator.read", "operator.write"]),
          administrator: role("write", ["operator.admin"]),
        },
      },
    },
  };
  const parentKey = `agent:main:dashboard:parent-${suffix}`;
  const targetKey = `agent:main:dashboard:target-${suffix}`;
  const creatorActor = { type: "human", source: "profile", id: creator.id } as const;
  const entry = (id: string, fields: Partial<SessionEntry>) =>
    sessionStoreEntry(id, {
      createdActor: creatorActor,
      visibility: "read-only",
      ...fields,
    });
  await writeSessionStore({
    entries: {
      [parentKey]: entry(`parent-${suffix}`, { communication: { receive: "always" } }),
      [targetKey]: entry(`target-${suffix}`, {
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
  const context = await makeContext();
  const read = (sessionKey = targetKey) => loadSessionEntry({ sessionKey, storePath });
  const rpc = (client: GatewayClient, method: string, params = {}) =>
    request(context, client, method, { key: targetKey, ...params });
  const success = async (client: GatewayClient, method: string, params = {}) =>
    expectSuccess(await rpc(client, method, params));
  const describeReopened = async () => {
    await disposeSessionReadContexts();
    await releaseGatewaySessionStoreFixture(dir);
    testState.sessionStorePath = storePath;
    (await getGatewayConfigModule()).clearRuntimeConfigSnapshot();
    return expectSuccess(
      await request(await makeContext(), identifiedClient(creator.id), "sessions.describe", {
        key: targetKey,
      }),
    );
  };
  return {
    creator,
    collaborator,
    parentKey,
    targetKey,
    creatorClient,
    collaboratorClient,
    adminClient,
    read,
    rpc,
    success,
    describeReopened,
    storePath,
  };
}

// The RPC router, unlike directSessionReq, enforces selected-profile authority.
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

function expectSuccess(result: Awaited<ReturnType<typeof request>>) {
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.payload;
}

test("sessions.create inherits communication for a new explicit child, not an adopted collaborator target", async () => {
  const f = await createFixture("adoption");
  const childKey = "agent:main:dashboard:communication-new-child";
  const child = await f.success(f.collaboratorClient, "sessions.create", {
    agentId: "main",
    key: childKey,
    parentSessionKey: f.parentKey,
  });
  expect(child).toMatchObject({
    key: childKey,
    entry: { parentSessionKey: f.parentKey, communication: { receive: "always" } },
  });
  expect(f.read(childKey)).toMatchObject({
    parentSessionKey: f.parentKey,
    communication: { receive: "always" },
    createdActor: { type: "human", id: f.collaborator.id },
  });

  const before = expectDefined(f.read(), "existing target");
  const adopted = await f.success(f.collaboratorClient, "sessions.create", {
    agentId: "main",
    key: f.targetKey,
    parentSessionKey: f.parentKey,
    label: "Adopted without changing communication",
  });
  expect(adopted).toMatchObject({
    key: f.targetKey,
    sessionId: before.sessionId,
    entry: { communication: { receive: "never" } },
  });
  const after = expectDefined(f.read(), "adopted target");
  // Parent and label prove adoption wrote the row, rather than returning a cached ACK.
  expect(after).toMatchObject({
    sessionId: before.sessionId,
    parentSessionKey: f.parentKey,
    label: "Adopted without changing communication",
    createdActor: before.createdActor,
    communication: { receive: "never" },
  });
});

test("communication writes require the creator or admin and existing creates cannot overwrite policy", async () => {
  const f = await createFixture("explicit");
  for (const method of ["sessions.create", "sessions.patch"] as const) {
    const denied = await f.rpc(f.collaboratorClient, method, {
      communication: { receive: "always" },
    });
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "Only the session creator or an admin can change communication settings.",
      },
    });
    expect(f.read()?.communication).toEqual({ receive: "never" });
  }
  const overwrite = await f.rpc(f.creatorClient, "sessions.create", {
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
    await f.success(client, "sessions.patch", {
      communication: { receive },
    });
    expect(f.read()?.communication).toEqual({ receive });
  }

  const beforeReset = expectDefined(f.read(), "target before reset");
  await f.success(f.adminClient, "sessions.reset");
  const resetEntry = expectDefined(f.read(), "reset target");
  expect(resetEntry.communication).toEqual({ receive: "never" });
  expect(resetEntry.sessionId).toBe(beforeReset.sessionId);
  expect(resetEntry.lifecycleRevision).not.toBe(beforeReset.lifecycleRevision);

  expect(await f.describeReopened()).toMatchObject({
    session: { sessionId: resetEntry.sessionId, communication: { receive: "never" } },
  });
  expect(f.read()?.communication).toEqual({ receive: "never" });
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
    const before = expectDefined(f.read(), "pre-feature stored row");
    expect(before).not.toHaveProperty("communication");

    expect(await f.success(f.creatorClient, "sessions.describe")).toMatchObject({
      session: { ...metadata, sessionId: before.sessionId, effectiveCommunication: effective },
    });
    // Describing a sparse row projects defaults without backfilling stored overrides.
    expect(f.read()).toEqual(before);

    await f.success(f.creatorClient, "sessions.patch", {
      expectedSessionId: before.sessionId,
      communication: { send: "ask" },
    });
    const expected = {
      ...metadata,
      sessionId: before.sessionId,
      createdActor: before.createdActor,
      communication: { send: "ask" },
    };
    expect(f.read()).toMatchObject(expected);
    expect(f.read()?.communication).toEqual({ send: "ask" });

    expect(await f.describeReopened()).toMatchObject({
      session: {
        ...expected,
        createdActor: { type: "human", id: f.creator.id },
        effectiveCommunication: { send: "ask", receive: effective.receive },
      },
    });
    expect(f.read()).toMatchObject(expected);
    expect(f.read()?.communication).toEqual({ send: "ask" });
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
    const creating = f.rpc(client, "sessions.create", {
      agentId: "main",
      key: childKey,
      parentSessionKey: f.parentKey,
      // Only an existing target needs creator authority; a new child needs parent access.
      ...(authority === "creator" ? { label: "must-not-commit" } : {}),
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
      expect(outcome.response).toMatchObject({
        ok: false,
        error:
          authority === "membership"
            ? { code: "INVALID_REQUEST", details: { code: "SESSION_PARTICIPATION_REQUIRED" } }
            : { code: "FORBIDDEN", message: "Gateway requester authority changed" },
      });
    }
    const persisted = f.read(childKey);
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

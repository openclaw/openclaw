import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, test, vi } from "vitest";
import * as promises from "../../test/helpers/promise.js";
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
import * as readContexts from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient, RespondFn } from "./server-methods/types.js";
import * as createHarness from "./server.sessions.create.test-support.js";
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

const { createSessionStoreDir } = createHarness.setupSessionCreateTestHarness();
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
  const person = (name: string, role = "collaborator") => {
    const profile = ensureProfileForEmail(`${name}-${suffix}@example.test`);
    setUserProfileRole(profile.id, role);
    const client = readContexts.identifiedClient(profile.id);
    if (role === "administrator") {
      client.connect.scopes = ["operator.admin"];
    }
    return { ...profile, client };
  };
  const creator = person("creator");
  const collaborator = person("collaborator");
  const admin = person("admin", "administrator");
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
  const entry = (id: string, fields: Partial<SessionEntry>) =>
    sessionStoreEntry(id, {
      createdActor: { type: "human", source: "profile", id: creator.id },
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
  const read = (sessionKey = targetKey) => loadSessionEntry({ sessionKey, storePath });
  for (const sessionKey of [parentKey, targetKey]) {
    sessionMembers.addSessionMember(
      { agentId: "main", sessionKey, storePath },
      {
        identityId: collaborator.id,
        addedBy: creator.id,
        expectedSessionId: expectDefined(read(sessionKey), "seeded session").sessionId,
      },
    );
  }
  createHarness.dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
  const makeContext = async () => {
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    context.readPreparedGatewayModelCatalog = async () => {
      const catalog = await context.loadGatewayModelCatalogSnapshot();
      return { entries: catalog.entries, routeVariants: catalog.routeVariants };
    };
    await readContexts.initializeSessionReadContext(context);
    return context;
  };
  let context = await makeContext();
  // Use the router: directSessionReq bypasses selected-profile authority.
  const rpc = async (client: GatewayClient, method: string, params = {}) => {
    const responses: Parameters<RespondFn>[] = [];
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "communication-" + method,
        method,
        params: { key: targetKey, ...params },
      },
      client,
      context,
      isWebchatConnect: () => false,
      respond: (...response) => responses.push(response),
    });
    await flushPendingSessionsChangedEvents(context);
    expect(responses).toHaveLength(1);
    const [ok, payload, error] = responses[0]!;
    return { ok, payload, error };
  };
  const expectSuccess = (result: Awaited<ReturnType<typeof rpc>>) => {
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.payload;
  };
  const success = async (client: GatewayClient, method: string, params = {}) =>
    expectSuccess(await rpc(client, method, params));
  const describeReopened = async () => {
    await readContexts.disposeSessionReadContexts();
    await releaseGatewaySessionStoreFixture(dir);
    testState.sessionStorePath = storePath;
    (await getGatewayConfigModule()).clearRuntimeConfigSnapshot();
    context = await makeContext();
    return await success(readContexts.identifiedClient(creator.id), "sessions.describe");
  };
  return {
    creator,
    collaborator,
    admin,
    parentKey,
    targetKey,
    read,
    rpc,
    success,
    describeReopened,
    storePath,
    expectStored: (fields: Partial<SessionEntry>, policy: SessionEntry["communication"]) => {
      const stored = read();
      expect(stored).toMatchObject(fields);
      expect(stored?.communication).toEqual(policy);
    },
  };
}

function expectError(result: { ok: boolean; error?: unknown }, code: string, message: string) {
  expect(result).toMatchObject({ ok: false, error: { code, message } });
}

test("sessions.create inherits communication for a new explicit child, not an adopted collaborator target", async () => {
  const f = await createFixture("adoption");
  const childKey = "agent:main:dashboard:communication-new-child";
  const child = await f.success(f.collaborator.client, "sessions.create", {
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
  const adopted = await f.success(f.collaborator.client, "sessions.create", {
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
    const denied = await f.rpc(f.collaborator.client, method, {
      communication: { receive: "always" },
    });
    expectError(
      denied,
      "FORBIDDEN",
      "Only the session creator or an admin can change communication settings.",
    );
    expect(f.read()?.communication).toEqual({ receive: "never" });
  }
  const overwrite = await f.rpc(f.creator.client, "sessions.create", {
    communication: { receive: "always" },
  });
  expectError(overwrite, "INVALID_REQUEST", "sessions.create communication requires a new session");
  for (const client of [f.creator.client, f.admin.client]) {
    const receive = client === f.creator.client ? "ask" : "never";
    await f.success(client, "sessions.patch", { communication: { receive } });
    expect(f.read()?.communication).toEqual({ receive });
  }

  const beforeReset = expectDefined(f.read(), "target before reset");
  await f.success(f.admin.client, "sessions.reset");
  const resetEntry = expectDefined(f.read(), "reset target");
  f.expectStored({ sessionId: beforeReset.sessionId }, { receive: "never" });
  expect(resetEntry.lifecycleRevision).not.toBe(beforeReset.lifecycleRevision);

  expect(await f.describeReopened()).toMatchObject({
    session: { sessionId: resetEntry.sessionId, communication: { receive: "never" } },
  });
  expect(f.read()?.communication).toEqual({ receive: "never" });
});

const configuredDefaults = { send: "never", receive: "ask" } as const;
test.each([
  ["built-in defaults", undefined, { send: "always", receive: "always" }],
  ["configured defaults", configuredDefaults, configuredDefaults],
] as const)(
  "preserves pre-feature sparse metadata with %s through RPC and SQLite reopen",
  async (name, defaults, effective) => {
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

    expect(await f.success(f.creator.client, "sessions.describe")).toMatchObject({
      session: { ...metadata, sessionId: before.sessionId, effectiveCommunication: effective },
    });
    // Describing a sparse row projects defaults without backfilling stored overrides.
    expect(f.read()).toEqual(before);

    await f.success(f.creator.client, "sessions.patch", {
      expectedSessionId: before.sessionId,
      communication: { send: "ask" },
    });
    const expected = {
      ...metadata,
      sessionId: before.sessionId,
      createdActor: before.createdActor,
      communication: { send: "ask" },
    };
    f.expectStored(expected, { send: "ask" });

    expect(await f.describeReopened()).toMatchObject({
      session: {
        ...expected,
        createdActor: { type: "human", id: f.creator.id },
        effectiveCommunication: { send: "ask", receive: effective.receive },
      },
    });
    f.expectStored(expected, { send: "ask" });
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
    const client = f[authority === "membership" ? "collaborator" : authority].client;
    const parent = { agentId: "main", sessionKey: f.parentKey, storePath: f.storePath };
    const resolved = resolveSqliteStoreScope(f.storePath, { agentId: "main" });
    const database = openOpenClawAgentDatabase({ agentId: "main", path: resolved.path });
    const transcriptCount = () =>
      database.db.prepare("SELECT count(*) AS count FROM transcript_events").get()?.count;
    const beforeTranscripts = transcriptCount();
    const entered = promises.createDeferred();
    const release = promises.createDeferred();
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
      await promises.withinTest(
        promises.awaitGateBeforeSettlement(
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

import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type {
  SessionActorStorageAuthority,
  SessionActorStorageCommand,
} from "../config/sessions/session-actor-storage-contract.js";
import {
  captureSessionEntryMetadataRead,
  captureSessionEntrySourceAssertion,
} from "../config/sessions/session-entry-source-authority.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  assertAssistantMediaPolicyCurrent,
  resolveAssistantMediaPolicy,
} from "./assistant-media-policy.js";
import { withManagedImageSessionRead } from "./managed-image-session-read.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
import type { GatewayClient } from "./server-methods/types.js";
import { readSessionMessagesMatchingIdAsync } from "./session-transcript-readers.js";
import {
  retainGatewaySessionEntryReadOnly,
  withGatewaySessionEntryReadOnly,
} from "./session-utils-read-lifetime.js";
import { withIncognitoGatewaySessionStoreTarget } from "./session-utils-store-retained.js";

// Real adapter reads and writes must not use SQLite or database workers.
vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory adapter opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  // Gateway adapters prepare actor writes on the main thread, including under Vitest's pool.
  isMainThread: true,
  Worker: vi.fn(function () {
    throw new Error("Memory adapter allocated a worker");
  }),
}));
// mock-isolation: Keep durable placement state outside the memory-only adapter fixture.
vi.mock("./session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: { getMany: () => new Map() },
  }),
}));

const cfg = { agents: { entries: { main: {}, work: {} } } };
const env = { OPENCLAW_STATE_DIR: "/synthetic/incognito-adapters" };
const sessionKey = "agent:main:dashboard:incognito-adapter";
const siblingKey = "agent:main:dashboard:incognito-sibling";
const otherKey = "agent:work:dashboard:incognito-other";
const authority: SessionActorStorageAuthority = { assertCurrent() {}, authorize() {} };
const actors: SessionActor[] = [];
const sessionScope = { agentId: "main", sessionKey, sessionId: sessionKey, env };

async function retainedMediaPolicy(selection: Parameters<typeof resolveAssistantMediaPolicy>[0]) {
  const value = await resolveAssistantMediaPolicy(selection);
  return { value, [Symbol.dispose]: () => value?.placementRead?.release() };
}

async function patch(actor: SessionActor, fields: Partial<InternalSessionEntry>) {
  await mutate(actor, {
    type: "session.entry.patch",
    input: { operation: { kind: "fields", patch: fields } },
  });
}

async function mutate(actor: SessionActor, command: SessionActorStorageCommand) {
  const result = await actor.storage!.mutate(command, authority);
  expect(result.kind).toBe("committed");
}

afterEach(async () => {
  await Promise.all(actors.splice(0).map((actor) => actor.release()));
  memorySessionActorOwners.reset();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

async function fixture(key = sessionKey) {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  setRuntimeConfigSnapshot(cfg);
  const agentId = key.split(":")[1]!;
  const owner = memorySessionActorOwners.get({
    agentId,
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
  });
  const actor = await owner.acquire(
    { sessionKey: key, database: owner.identity },
    {
      assertCurrent() {},
      assertReadable() {},
    },
  );
  actors.push(actor);
  await mutate(actor, {
    type: "session.entry.create",
    input: {
      entry: {
        sessionId: key,
        createdAt: 1,
        updatedAt: 1,
        incognito: true,
        category: "original",
        sessionRoot: "/synthetic/workspace",
      },
    },
  });
  const binding: SessionActorStorageBinding = {
    actor,
    authority,
    agentId: owner.agentId,
    path: owner.path,
  };
  return { owner, actor, binding };
}

it("reads current memory rows without acquiring sessions or opening an absent owner", async () => {
  let escapedAssertion: (() => void) | undefined;
  const read = (canonicalKey = sessionKey) =>
    withIncognitoGatewaySessionStoreTarget({
      env,
      identity: { agentId: canonicalKey.split(":")[1]!, canonicalKey },
      includeMembership: true,
      consume(target, membership, assertCurrent) {
        assertCurrent();
        escapedAssertion = assertCurrent;
        return { entry: target.store[canonicalKey], members: membership.get(canonicalKey) };
      },
    });
  expect(read()).toEqual({ entry: undefined, members: [] });
  expect(memorySessionActorOwners.list()).toEqual([]);
  const { actor, binding, owner } = await fixture();
  await fixture(siblingKey);
  await fixture(otherKey);
  expect(read()).toMatchObject({ entry: { category: "original" }, members: [] });
  expect(escapedAssertion).toThrow("no longer retained");
  await patch(actor, { category: "updated" });
  expect(read()).toMatchObject({ entry: { category: "updated" } });
  const member = { identityId: "viewer@example.test", addedBy: "owner", addedAt: 2 };
  await mutate(actor, { type: "session.collaboration.add", input: { params: member } });
  expect(read()).toMatchObject({ members: [member] });
  await mutate(actor, {
    type: "session.collaboration.remove",
    input: { identityId: member.identityId },
  });
  expect(read()).toMatchObject({ members: [] });
  expect(read(siblingKey)).toMatchObject({ entry: { sessionId: siblingKey } });
  expect(read(otherKey)).toMatchObject({ entry: { sessionId: otherKey } });
  expect(read("agent:main:dashboard:incognito-missing")).toEqual({ entry: undefined, members: [] });
  expect(owner.listSessions(authority)).toHaveLength(2);
  owner.closeSession(sessionKey);
  expect(read()).toEqual({ entry: undefined, members: [] });
  expect(() => runWithSessionActorStorage(binding, read)).toThrow("closed");
});

it("retains detached planning data and rejects effects after the selected actor closes", async () => {
  const { actor, binding, owner } = await fixture();
  let escapedAssertion: (() => void) | undefined;
  await runWithSessionActorStorage(binding, () =>
    withGatewaySessionEntryReadOnly({ cfg, key: sessionKey }, async (loaded, assertCurrent) => {
      expect(loaded.entry?.category).toBe("original");
      escapedAssertion = assertCurrent;
      await patch(actor, { category: "updated" });
      expect(loaded.entry?.category).toBe("original");
      assertCurrent();
      owner.closeSession(sessionKey);
      expect(assertCurrent).toThrow("closed");
    }),
  );
  expect(escapedAssertion).toThrow("no longer retained");
});

it("keeps workspace effect predicates current without pinning unrelated planning metadata", async () => {
  const { binding, owner } = await fixture();
  let captured: ReturnType<typeof captureSessionEntryMetadataRead>;
  await runWithSessionActorStorage(binding, () =>
    withGatewaySessionEntryReadOnly({ cfg, key: sessionKey }, async (loaded) => {
      expect(loaded.entry?.sessionRoot).toBe("/synthetic/workspace");
      const scope = { agentId: "main", sessionKey, storePath: loaded.storePath };
      captured = captureSessionEntryMetadataRead(scope, () => {});
      const source = captureSessionEntrySourceAssertion({
        scope,
        expected: loaded.entry,
        fields: ["sessionId", "lifecycleRevision", "projectId", "worktree"],
        assertCurrent() {},
        refuse() {
          throw new Error("Workspace authority changed");
        },
      });
      await patchSessionEntryCore(scope, () => ({ displayName: "Updated title" }), {
        ...sessionEntryCommitGuardOptions(source),
        requireWriteSuccess: true,
      });
      expect(source).not.toThrow();
      await patchSessionEntryCore(scope, () => ({ projectId: "attached-project" }), {
        requireWriteSuccess: true,
      });
      expect(source).toThrow("Workspace authority changed");
      expect(captured?.readCurrent()?.projectId).toBe("attached-project");
    }),
  );
  owner.closeSession(sessionKey);
  await fixture();
  expect(() => captured?.readCurrent()).toThrow("closed");
});

it("rechecks metadata only at response and honors the caller's allowed metadata changes", async () => {
  const { actor, owner } = await fixture();
  const read = await retainGatewaySessionEntryReadOnly(
    sessionKey,
    "main",
    (previous, current) => previous.category === current.category,
    cfg,
  );
  try {
    expect(read.isCurrentAtResponse()).toBe(true);
    await patch(actor, { displayName: "Changed title" });
    expect(read.isCurrentAtResponse()).toBe(true);
    await patch(actor, { category: "another-category" });
    expect(read.isCurrentAtResponse()).toBe(false);
    expect(read.isCurrent()).toBe(true);
    owner.close();
    expect(read.isCurrent()).toBe(false);
  } finally {
    read.release();
  }
  expect(read.isCurrent()).toBe(false);
});

it("projects unbound memory watches from current facts with the existing recipient policy", async () => {
  const { owner } = await fixture();
  await fixture(siblingKey);
  await fixture(otherKey);
  const person = { text: "watcher", ts: 1 };
  const project = createPresenceRecipientProjection({
    cfg,
    presence: [{ ...person, watchedSessions: [sessionKey, siblingKey, otherKey] }],
  });
  const client: GatewayClient = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.admin"],
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
  };
  expect(project(client)).toEqual([
    { ...person, watchedSessions: [sessionKey, siblingKey, otherKey] },
  ]);
  owner.closeSession(siblingKey);
  expect(project(client)).toEqual([{ ...person, watchedSessions: [sessionKey, otherKey] }]);
  client.connect.scopes = ["operator.read"];
  client.authenticatedUserId = "viewer@example.test";
  client.authenticatedUserProfile = {
    profileId: "viewer@example.test",
    displayName: null,
    hasAvatar: false,
    updatedAt: 1,
  };
  expect(project(client)).toEqual([person]);
  expect(project(null)).toEqual([]);
  owner.closeSession(sessionKey);
  client.connect.scopes = ["operator.admin"];
  expect(project(client)).toEqual([{ ...person, watchedSessions: [otherKey] }]);
  owner.close();
  expect(() => project(client)).toThrow("closed");
});

it("uses current actor media policy for unbound incognito reads and refuses closed sessions", async () => {
  const { actor, owner } = await fixture();
  const requestAuth = { authMethod: "token" as const, operatorScopes: ["operator.admin"] };
  const selection = { config: cfg, sessionKey, agentId: "main", requestAuth };
  using policyRead = await retainedMediaPolicy(selection);
  const policy = policyRead.value;
  expect(policy?.session).toEqual({ sessionKey, agentId: "main", sessionId: sessionKey });
  expect(policy?.localRoots).toContain("/synthetic/workspace");
  await patch(actor, { sessionRoot: "/synthetic/changed" });
  expect(() => assertAssistantMediaPolicyCurrent(selection, policy!, false, requestAuth)).toThrow(
    "Media access changed",
  );
  using currentRead = await retainedMediaPolicy(selection);
  const current = currentRead.value;
  expect(current?.localRoots).toContain("/synthetic/changed");
  expect(() =>
    assertAssistantMediaPolicyCurrent(selection, current!, false, requestAuth),
  ).not.toThrow();
  owner.closeSession(sessionKey);
  expect(await resolveAssistantMediaPolicy(selection)).toBeUndefined();
  expect(() => assertAssistantMediaPolicyCurrent(selection, current!, false, requestAuth)).toThrow(
    "Media access changed",
  );
});

it("retains the memory transcript source through managed media reads and refuses a closed actor", async () => {
  const params = {
    cfg,
    agentId: "main",
    sessionKey,
    stateDir: env.OPENCLAW_STATE_DIR,
    assertCurrent() {},
  };
  expect(await withManagedImageSessionRead(params, async () => "unexpected")).toBeNull();
  expect(memorySessionActorOwners.list()).toEqual([]);
  const { owner } = await fixture();
  await persistSessionTranscriptTurn(sessionScope, {
    messages: [
      {
        eventId: "media-message",
        message: { role: "assistant", content: "Media", __openclaw: { id: "media-message" } },
      },
    ],
  });
  await withManagedImageSessionRead(params, async (scope, assertCurrent) => {
    expect(scope.sessionId).toBe(sessionKey);
    const messages = await readSessionMessagesMatchingIdAsync(scope, "media-message");
    expect(messages).toMatchObject([{ role: "assistant", content: "Media" }]);
    assertCurrent();
    owner.closeSession(sessionKey);
    expect(assertCurrent).toThrow("closed");
  });
});

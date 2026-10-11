import { afterEach, expect, it, vi } from "vitest";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "../config/sessions/session-actor-storage-contract.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
import type { GatewayClient } from "./server-methods/types.js";
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
  Worker: vi.fn(function () {
    throw new Error("Memory adapter allocated a worker");
  }),
}));

const cfg = { agents: { entries: { main: {}, work: {} } } };
const env = { OPENCLAW_STATE_DIR: "/synthetic/incognito-adapters" };
const sessionKey = "agent:main:dashboard:incognito-adapter";
const siblingKey = "agent:main:dashboard:incognito-sibling";
const otherKey = "agent:work:dashboard:incognito-other";
const authority: SessionActorStorageAuthority = { assertCurrent() {}, authorize() {} };
const actors: SessionActor[] = [];

afterEach(async () => {
  await Promise.all(actors.splice(0).map((actor) => actor.release()));
  memorySessionActorOwners.reset();
});

async function fixture(key = sessionKey) {
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
  const result = await actor.storage!.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: {
          sessionId: key,
          createdAt: 1,
          updatedAt: 1,
          incognito: true,
          projectId: "original",
          sessionRoot: "/synthetic/workspace",
        },
      },
    },
    authority,
  );
  expect(result.kind).toBe("committed");
  const binding: SessionActorStorageBinding = {
    actor,
    authority,
    agentId: owner.agentId,
    path: owner.path,
  };
  return { owner, actor, binding };
}

it("reads current exact and sibling actor rows and never resolves selected absence natively", async () => {
  const { actor, binding, owner } = await fixture();
  await fixture(siblingKey);
  await fixture(otherKey);
  let escapedAssertion: (() => void) | undefined;
  const read = (canonicalKey = sessionKey) =>
    runWithSessionActorStorage(binding, () =>
      withIncognitoGatewaySessionStoreTarget({
        identity: { agentId: canonicalKey.split(":")[1]!, canonicalKey },
        includeMembership: true,
        resolve() {
          throw new Error("Selected memory read fell back to native");
        },
        consume(target, membership, assertCurrent) {
          assertCurrent();
          escapedAssertion = assertCurrent;
          return { entry: target.store[canonicalKey], members: membership.get(canonicalKey) };
        },
      }),
    );
  expect(read()).toMatchObject({ entry: { projectId: "original" }, members: [] });
  expect(escapedAssertion).toThrow("no longer retained");
  const patched = await actor.storage!.mutate(
    {
      type: "session.entry.patch",
      input: { operation: { kind: "fields", patch: { projectId: "updated" } } },
    },
    authority,
  );
  expect(patched.kind).toBe("committed");
  expect(read()).toMatchObject({ entry: { projectId: "updated" } });
  const member = { identityId: "viewer@example.test", addedBy: "owner", addedAt: 2 };
  const added = await actor.storage!.mutate(
    { type: "session.collaboration.add", input: { params: member } },
    authority,
  );
  expect(added.kind).toBe("committed");
  expect(read()).toMatchObject({ members: [member] });
  const removed = await actor.storage!.mutate(
    { type: "session.collaboration.remove", input: { identityId: member.identityId } },
    authority,
  );
  expect(removed.kind).toBe("committed");
  expect(read()).toMatchObject({ members: [] });
  expect(read(siblingKey)).toMatchObject({ entry: { sessionId: siblingKey } });
  expect(read(otherKey)).toMatchObject({ entry: { sessionId: otherKey } });
  expect(read("agent:main:dashboard:incognito-missing")).toEqual({ entry: undefined, members: [] });
  owner.closeSession(sessionKey);
  expect(read).toThrow("closed");
});

it("retains detached planning data and rejects effects after the selected actor closes", async () => {
  const { actor, binding, owner } = await fixture();
  let escapedAssertion: (() => void) | undefined;
  await runWithSessionActorStorage(binding, () =>
    withGatewaySessionEntryReadOnly({ cfg, key: sessionKey }, async (loaded, assertCurrent) => {
      expect(loaded.entry).toMatchObject({
        projectId: "original",
        sessionRoot: "/synthetic/workspace",
      });
      escapedAssertion = assertCurrent;
      const patched = await actor.storage!.mutate(
        {
          type: "session.entry.patch",
          input: { operation: { kind: "fields", patch: { projectId: "updated" } } },
        },
        authority,
      );
      expect(patched.kind).toBe("committed");
      expect(loaded.entry?.projectId).toBe("original");
      assertCurrent();
      owner.closeSession(sessionKey);
      expect(assertCurrent).toThrow("closed");
    }),
  );
  expect(escapedAssertion).toThrow("no longer retained");
});

it("rechecks metadata only at response and honors the caller's allowed metadata changes", async () => {
  const { actor, binding, owner } = await fixture();
  const read = runWithSessionActorStorage(binding, () =>
    retainGatewaySessionEntryReadOnly(
      sessionKey,
      "main",
      (previous, current) => previous.projectId === current.projectId,
      cfg,
    ),
  );
  try {
    expect(read.isCurrentAtResponse()).toBe(true);
    const title = await actor.storage!.mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { displayName: "Changed title" } } },
      },
      authority,
    );
    expect(title.kind).toBe("committed");
    expect(read.isCurrentAtResponse()).toBe(true);
    const project = await actor.storage!.mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { projectId: "another-project" } } },
      },
      authority,
    );
    expect(project.kind).toBe("committed");
    expect(read.isCurrentAtResponse()).toBe(false);
    expect(read.isCurrent()).toBe(true);
    owner.close();
    expect(read.isCurrent()).toBe(false);
  } finally {
    read.release();
  }
  expect(read.isCurrent()).toBe(false);
});

it("projects selected memory watches from current facts with the existing recipient policy", async () => {
  const { binding, owner } = await fixture();
  await fixture(siblingKey);
  await fixture(otherKey);
  const person = { text: "watcher", ts: 1 };
  const project = runWithSessionActorStorage(binding, () =>
    createPresenceRecipientProjection({
      cfg,
      presence: [{ ...person, watchedSessions: [sessionKey, siblingKey, otherKey] }],
    }),
  );
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
  expect(project(client)).toEqual([person]);
  expect(project(null)).toEqual([]);
  owner.closeSession(sessionKey);
  client.connect.scopes = ["operator.admin"];
  expect(() => project(client)).toThrow("closed");
});

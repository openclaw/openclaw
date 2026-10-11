import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import {
  isSessionMember,
  listSessionMembers,
  readSessionMembersInWorker,
} from "../config/sessions/session-sharing-store.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import {
  prepareSessionSharingTargets,
  resolveSessionSharingTarget,
} from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { prepareSessionSharingSource } from "./session-sharing-source.js";
import { prepareSessionSharingRead } from "./session-sharing-target-read.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory sharing opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory sharing allocated a worker");
  }),
}));

const sessionKey = "agent:main:dashboard:incognito-memory-sharing";
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const cfg = { agents: { entries: { main: {} } } };
const owners: ReturnType<typeof memorySessionActorOwners.get>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    memorySessionActorOwners.closeDatabase(owner);
  }
});

async function fixture() {
  const path = "/synthetic/sharing/agents/main/agent/incognito-openclaw-agent.sqlite";
  const owner = memorySessionActorOwners.get({ agentId: "main", path });
  owners.push(owner);
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  if (!actor.storage) {
    throw new Error("Missing memory storage");
  }
  const binding: SessionActorStorageBinding = { actor, authority, agentId: "main", path };
  return { owner, actor, storage: actor.storage, binding };
}

it("prepares missing sharing facts and reads committed creation and membership without native grants", async () => {
  const { owner, storage, binding } = await fixture();
  const prepared = await runWithSessionActorStorage(binding, async () => ({
    facts: await prepareSessionMutationFacts({
      cfg,
      sessionKey,
      agentId: "main",
      allowMissing: true,
    }),
    read: await prepareSessionSharingRead({ cfg, sessionKey, agentId: "main" }),
    source: await prepareSessionSharingSource(
      { agentId: "main", canonicalKey: sessionKey, storeKey: sessionKey, storePath: binding.path },
      () => authority.assertCurrent(),
    ),
  }));
  try {
    expect(prepared.facts.readCurrent(cfg).target).toBeNull();
    expect(prepared.source.target).toBeNull();
    expect(
      await storage.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: "memory-sharing", updatedAt: 1 }, cwd: "/synthetic" },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
    expect(
      await storage.mutate(
        {
          type: "session.collaboration.add",
          input: { params: { identityId: "reader", addedBy: "owner", addedAt: 1 } },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
    expect(prepared.facts.readCurrent(cfg).target?.entry.sessionId).toBe("memory-sharing");
    expect(prepared.read.readCurrent(cfg).membership).toEqual(new Set(["reader"]));
    expect(prepared.source.members).toEqual(["reader"]);

    await storage.mutate(
      { type: "session.collaboration.remove", input: { identityId: "reader" } },
      authority,
    );
    expect(prepared.facts.readCurrent(cfg).membership).toEqual(new Set());
    expect(prepared.source.members).toEqual([]);
    runWithSessionActorStorage(binding, () => {
      expect(resolveSessionSharingTarget({ cfg, sessionKey })?.entry.sessionId).toBe(
        "memory-sharing",
      );
      expect(prepareSessionSharingTargets({ cfg, targets: [{ sessionKey }] })).toMatchObject([
        { ok: true, value: { entry: { sessionId: "memory-sharing" } } },
      ]);
      expect(() =>
        resolveSessionSharingTarget({
          cfg: {
            ...cfg,
            session: {
              store: "/synthetic/other/agents/main/agent/incognito-openclaw-agent.sqlite",
            },
          },
          sessionKey,
        }),
      ).toThrow("another owner");
    });
    owner.closeSession(sessionKey);
    expect(() => prepared.facts.readCurrent(cfg)).toThrow(/closed/);
    expect(() => prepared.source.assertCurrent()).toThrow(/closed/);
  } finally {
    prepared.facts.release();
    prepared.read.release();
    await prepared.source.release();
  }
  expect(() => prepared.source.assertCurrent()).toThrow("no longer retained");
});

it("reads sibling and batch sharing from the captured owner after leaving the actor scope", async () => {
  const { binding, owner, storage } = await fixture();
  const siblingKey = "agent:main:dashboard:incognito-memory-sharing-sibling";
  const sibling = await storage.acquire(siblingKey);
  if (!sibling.storage) {
    throw new Error("Missing sibling memory storage");
  }
  await sibling.storage.mutate(
    {
      type: "session.entry.create",
      input: { entry: { sessionId: "sibling-session", updatedAt: 1 }, cwd: "/synthetic" },
    },
    authority,
  );
  const prepared = await runWithSessionActorStorage(binding, async () => {
    const scope = { agentId: "main", sessionKey: siblingKey, storePath: binding.path };
    expect(
      await sibling.storage!.mutate(
        {
          type: "session.collaboration.add",
          input: { params: { identityId: "sibling-reader", addedBy: "owner", addedAt: 1 } },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
    expect(isSessionMember(scope, "sibling-reader")).toBe(true);
    expect(listSessionMembers(scope)).toEqual([
      { identityId: "sibling-reader", addedBy: "owner", addedAt: 1 },
    ]);
    expect((await readSessionMembersInWorker(scope)).members).toHaveLength(1);
    await sibling.storage!.mutate(
      { type: "session.collaboration.remove", input: { identityId: "sibling-reader" } },
      authority,
    );
    expect(isSessionMember(scope, "sibling-reader")).toBe(false);
    expect(listSessionMembers(scope)).toEqual([]);
    expect(
      await readSessionMembersInWorker({
        agentId: "other",
        sessionKey: "agent:other:dashboard:incognito-absent-owner",
      }),
    ).toEqual({ entry: undefined, members: [] });
    expect(
      prepareSessionSharingTargets({
        cfg: { agents: { entries: { main: {}, other: {} } } },
        targets: [{ sessionKey: "agent:other:dashboard:incognito-absent-owner" }],
      }),
    ).toEqual([{ ok: true, value: null }]);
    expect(
      prepareSessionSharingTargets({ cfg, targets: [{ sessionKey }, { sessionKey: siblingKey }] }),
    ).toMatchObject([
      { ok: true, value: null },
      { ok: true, value: { entry: { sessionId: "sibling-session" } } },
    ]);
    return {
      facts: await prepareSessionMutationFacts({ cfg, sessionKey: siblingKey, agentId: "main" }),
      source: await prepareSessionSharingSource(
        {
          agentId: "main",
          canonicalKey: siblingKey,
          storeKey: siblingKey,
          storePath: binding.path,
        },
        () => authority.assertCurrent(),
      ),
    };
  });
  try {
    await sibling.storage.mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { label: "Sibling postimage" } } },
      },
      authority,
    );
    expect(prepared.facts.readCurrent(cfg).target?.entry.label).toBe("Sibling postimage");
    expect(prepared.source.target?.entry.label).toBe("Sibling postimage");
    memorySessionActorOwners.closeDatabase(owner);
    const replacement = memorySessionActorOwners.get(owner);
    owners.push(replacement);
    expect(() => prepared.source.assertCurrent()).toThrow(/closed/);
  } finally {
    prepared.facts.release();
    await prepared.source.release();
    await sibling.release();
  }
});

it.each(["chat.send", "sessions.dispatch"] as const)(
  "retains memory sharing for %s and refuses revoked incognito access at the effect",
  async (method) => {
    const { binding, storage } = await fixture();
    await storage.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId: "authorized-memory", updatedAt: 1 }, cwd: "/synthetic" },
      },
      authority,
    );
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => cfg;
    context.getCommittedRuntimeConfig = () => cfg;
    const client = sharingPolicyClient({ scopes: ["operator.admin"] });
    const result = await runWithSessionActorStorage(binding, () =>
      resolveSessionMutationAuthorizationAsync({
        client,
        method,
        requestParams:
          method === "chat.send"
            ? { sessionKey, agentId: "main" }
            : { key: sessionKey, agentId: "main" },
        expectedTarget: {
          agentId: "main",
          sessionKey,
          sessionId: "authorized-memory",
          storePath: binding.path,
        },
        context,
      }),
    );
    expect(result.error).toBeNull();
    if (!result.authorization) {
      throw new Error("Missing sharing authorization");
    }
    const prepared = await prepareSessionSourceAuthority(result.authorization.assertCurrent);
    const grant = await result.authorization.prepareWorkerGrant?.();
    try {
      expect(prepared.nativeSource).not.toBe(true);
      prepared.assertCurrent();
      grant?.assertCurrent();
      if (method === "chat.send") {
        expect(result.authorization.admittedInputAuthority).toBeDefined();
        await result.authorization.admittedInputAuthority!.withCurrent((facts, assertCurrent) => {
          expect(facts.entry?.sessionId).toBe("authorized-memory");
          assertCurrent();
        });
      }
      await storage.mutate(
        {
          type: "session.entry.patch",
          input: { operation: { kind: "fields", patch: { label: "Current" } } },
        },
        authority,
      );
      prepared.assertCurrent();
      client.connect.scopes = ["operator.read", "operator.write"];
      client.authenticatedUserId = "other-person";
      client.authenticatedUserProfile = {
        profileId: "other-person",
        displayName: null,
        hasAvatar: false,
        updatedAt: 1,
      };
      expect(() => prepared.assertCurrent()).toThrow(SessionMutationAuthorizationChangedError);
      if (grant) {
        expect(() => grant.assertCurrent()).toThrow(SessionMutationAuthorizationChangedError);
      }
    } finally {
      await grant?.release();
      await prepared.release?.();
    }
  },
);

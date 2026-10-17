import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { readSessionMembersInWorker } from "../config/sessions/session-sharing-store.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { resolveSessionSharingTargetAsync } from "./session-sharing-policy.js";
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
beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/sharing"));
afterEach(() => {
  vi.unstubAllEnvs();
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

function operations(storage: Awaited<ReturnType<typeof fixture>>["storage"]) {
  const mutate = (command: Parameters<typeof storage.mutate>[0]) =>
    storage.mutate(command, authority);
  return {
    create: (sessionId: string) =>
      mutate({
        type: "session.entry.create",
        input: { entry: { sessionId, updatedAt: 1 }, cwd: "/synthetic" },
      }),
    add: (identityId: string) =>
      mutate({
        type: "session.collaboration.add",
        input: { params: { identityId, addedBy: "owner", addedAt: 1 } },
      }),
    remove: (identityId: string) =>
      mutate({ type: "session.collaboration.remove", input: { identityId } }),
    label: (label: string) =>
      mutate({
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { label } } },
      }),
  };
}

const prepareSource = (storePath: string, key = sessionKey) =>
  prepareSessionSharingSource(
    { agentId: "main", canonicalKey: key, storeKey: key, storePath },
    () => authority.assertCurrent(),
  );

it("prepares unbound sharing facts and observes committed creation and membership without SQLite", async () => {
  const { owner, storage, binding } = await fixture();
  const ops = operations(storage);
  const prepared = {
    facts: await prepareSessionMutationFacts({
      cfg,
      sessionKey,
      agentId: "main",
      allowMissing: true,
    }),
    read: await prepareSessionSharingRead({ cfg, sessionKey, agentId: "main" }),
    source: await prepareSource(binding.path),
  };
  try {
    expect(prepared.facts.readCurrent(cfg).target).toBeNull();
    expect(prepared.source.target).toBeNull();
    expect(await ops.create("memory-sharing")).toMatchObject({ kind: "committed" });
    expect(await ops.add("reader")).toMatchObject({ kind: "committed" });
    expect(prepared.facts.readCurrent(cfg).target?.entry.sessionId).toBe("memory-sharing");
    expect(prepared.read.readCurrent(cfg).membership).toEqual(new Set(["reader"]));
    expect(prepared.source.members).toEqual(["reader"]);

    await ops.remove("reader");
    expect(prepared.facts.readCurrent(cfg).membership).toEqual(new Set());
    expect(prepared.source.members).toEqual([]);
    await runWithSessionActorStorage(binding, async () => {
      expect((await resolveSessionSharingTargetAsync({ cfg, sessionKey }))?.entry.sessionId).toBe(
        "memory-sharing",
      );
      await expect(
        resolveSessionSharingTargetAsync({
          cfg: {
            ...cfg,
            session: {
              store: "/synthetic/other/agents/main/agent/incognito-openclaw-agent.sqlite",
            },
          },
          sessionKey,
        }),
      ).rejects.toThrow("another state root");
    });
    owner.closeSession(sessionKey);
    expect(prepared.facts.readCurrent(cfg).target).toBeNull();
    expect(prepared.source.target).toBeNull();
  } finally {
    prepared.facts.release();
    prepared.read.release();
    await prepared.source.release();
  }
  expect(() => prepared.source.assertCurrent()).toThrow("no longer retained");
});

it("reads unbound sibling sharing from the captured owner", async () => {
  const { binding, owner, storage } = await fixture();
  const siblingKey = "agent:main:dashboard:incognito-memory-sharing-sibling";
  const sibling = await storage.acquire(siblingKey);
  if (!sibling.storage) {
    throw new Error("Missing sibling memory storage");
  }
  const ops = operations(sibling.storage);
  await ops.create("sibling-session");
  const scope = { agentId: "main", sessionKey: siblingKey, storePath: binding.path };
  expect(await ops.add("sibling-reader")).toMatchObject({ kind: "committed" });
  expect((await readSessionMembersInWorker(scope)).members).toEqual([
    { identityId: "sibling-reader", addedBy: "owner", addedAt: 1 },
  ]);
  await ops.remove("sibling-reader");
  expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
  expect(
    await readSessionMembersInWorker({
      agentId: "other",
      sessionKey: "agent:other:dashboard:incognito-absent-owner",
    }),
  ).toEqual({ entry: undefined, members: [] });
  const prepared = {
    facts: await prepareSessionMutationFacts({ cfg, sessionKey: siblingKey, agentId: "main" }),
    source: await prepareSource(binding.path, siblingKey),
  };
  try {
    await ops.label("Sibling postimage");
    expect(prepared.facts.readCurrent(cfg).target?.entry).toMatchObject({
      label: "Sibling postimage",
    });
    expect(prepared.source.target?.entry).toMatchObject({ label: "Sibling postimage" });
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

it.each(["chat.send", "sessions.dispatch", "sessions.move"] as const)(
  "retains memory sharing for %s and refuses revoked incognito access at the effect",
  async (method) => {
    const { binding, storage } = await fixture();
    const ops = operations(storage);
    await ops.create("authorized-memory");
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => cfg;
    context.getCommittedRuntimeConfig = () => cfg;
    const client = sharingPolicyClient({ scopes: ["operator.admin"] });
    const result = await resolveSessionMutationAuthorizationAsync({
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
    });
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
      await ops.label("Current");
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

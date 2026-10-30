import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareReplyToolAuthorityCallerRead } from "../../agents/harness/host-private-capabilities.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { prepareSessionResetCleanupGuard } from "../../auto-reply/reply/session-reset-cleanup.js";
import { prepareSteeringDelivery } from "../../auto-reply/reply/steering-delivery-preparation.js";
import { createCompletionGrantLineageAdmission } from "../../gateway/tool-resolution-completion.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { applySessionEntryOperation } from "./session-accessor.sqlite-entry.js";
import type { SessionActor, SessionActorAuthority } from "./session-actor-contract.js";
import { createSessionActorFactory } from "./session-actor-durable.js";
import { memoryOwnerFixture } from "./session-actor-memory-family.test-support.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { memoryStorage } from "./session-actor-memory-publication.test-support.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import {
  prepareSessionDeliveryGeneration,
  prepareSessionGenerationFacts,
} from "./session-delivery-generation.js";
import { acquireSessionInputActor } from "./session-input-actor.js";
import { buildSessionTranscriptTurnExpectedState } from "./session-transcript-turn-state.js";
import type { SessionTurnPlan } from "./session-turn.types.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

// A memory actor must not allocate either persistence or database-worker capacity.
vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory actor opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory actor allocated a worker");
  }),
}));

const sessionKey = "agent:main:dashboard:incognito-actor-test";
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const database = { agentId: "main", path: "/synthetic/incognito" };
const openFixture = memoryOwnerFixture(database);
afterEach(async () => {
  await Promise.all(actors.splice(0).map((actor) => actor.release()));
  memorySessionActorOwners.reset();
});

async function fixture() {
  const { actor } = await openFixture(sessionKey);
  await initialize(actor, "accept", {
    sessionFile: "/synthetic/transcript",
    cwd: "/synthetic",
    messages: [
      {
        message: { role: "user", content: "Hello", timestamp: 1, idempotencyKey: "input-1" },
        eventId: "user-1",
        now: 1,
      },
    ],
  });
  return { actor };
}

const activityCommand = (updatedAt: number) => ({
  commandId: `activity-${updatedAt}`,
  phaseId: "turn",
  reducers: [{ kind: "activity" as const, updatedAt }],
});

describe("memory session actor", () => {
  it("detaches committed receipts and rejects a stale command version", async () => {
    const { actor } = await fixture();
    const old = actor.snapshot(authority)!;
    const result = await actor.patch(activityCommand(10), authority);
    if (result.kind !== "committed") {
      throw new Error("Expected a committed receipt");
    }
    const retained = actor.snapshot(authority);
    Object.assign(result.receipt.afterVersion, { sequence: 100 });
    result.receipt.transcript.after.rawSeq = 100;
    expect(actor.snapshot(authority)).toEqual(retained);
    expect(
      await actor.patch(
        {
          ...activityCommand(99),
          expected: old.version,
        },
        authority,
      ),
    ).toMatchObject({
      kind: "stale-version",
      postimage: { entry: { updatedAt: 10 } },
    });
    await actor.release();
  });

  it.each(["transaction", "commit"] as const)(
    "rolls back refused %s admission and preserves commits when an observer fails",
    async (refusedStage) => {
      const { actor } = await fixture();
      const before = actor.snapshot(authority)!;
      const refused = await actor.patch(activityCommand(50), {
        assertCurrent() {},
        authorize(stage) {
          if (stage === refusedStage) {
            throw new Error("revoked");
          }
        },
      });
      expect(refused).toMatchObject({ kind: "rolled-back", error: { message: "revoked" } });
      expect(actor.snapshot(authority)).toEqual(before);
      const committed = await actor.patch(activityCommand(51), authority, {
        committed() {
          throw new Error("observer failed");
        },
      });
      expect(committed).toMatchObject({
        kind: "committed",
        failure: { message: "observer failed" },
        receipt: { postimage: { entry: { updatedAt: 51 } } },
      });
      expect(actor.snapshot(authority)?.entry?.updatedAt).toBe(51);
      await actor.release();
    },
  );
});

const actors: SessionActor[] = [];

async function acquireRegistered(options = database, key = sessionKey) {
  const actor = await createSessionActorFactory(options).acquire(
    { sessionKey: key, database: { kind: "memory" } },
    lifetime,
  );
  if ("kind" in actor) {
    throw new Error("Expected a memory actor");
  }
  actors.push(actor);
  return actor;
}

async function initialize(
  actor: SessionActor,
  commandId = "initialize",
  options: Partial<SessionTurnPlan["options"]> = {},
) {
  const result = await actor.acceptInput(
    {
      commandId,
      phaseId: "turn",
      expectedState: buildSessionTranscriptTurnExpectedState({
        sessionId: "session-1",
        updatedAt: 1,
      }),
      lifecycle: {},
      turn: {
        agentId: "main",
        sessionKey: actor.target.sessionKey,
        options: {
          expectedSessionId: "session-1",
          sessionFile: sessionKey,
          initialSessionEntry: { sessionId: "session-1", updatedAt: 1, incognito: true },
          messages: [{ message: { role: "user", content: "Hello" }, eventId: "user-1", now: 1 }],
          ...options,
        },
      },
    },
    authority,
  );
  expect(result.kind).toBe("committed");
}

describe("memory actor owner registry", () => {
  it("selects one memory owner across factories without opening SQLite or allocating a worker", async () => {
    expect(memorySessionActorOwners.read(database)).toBeUndefined();
    const actor = await acquireRegistered();
    const same = await acquireRegistered({
      agentId: "MAIN",
      path: "/synthetic/unused/../incognito",
    });
    await initialize(actor);
    const owner = memorySessionActorOwners.read(database)!;
    const owned = await owner.acquire(actor.target, lifetime);
    actors.push(owned);
    await owned.patch(activityCommand(10), authority);
    expect(actor.snapshot(authority)?.entry?.updatedAt).toBe(10);
    expect(same.snapshot(authority)?.entry?.updatedAt).toBe(10);
  });

  it("closes the selected session on the acquired owner while retaining its siblings", async () => {
    const actor = await acquireRegistered();
    const sibling = await acquireRegistered(database, "agent:main:dashboard:incognito-sibling");
    await initialize(actor);
    await initialize(sibling);
    memorySessionActorOwners.closeSession(database, sessionKey);
    expect(() => actor.snapshot(authority)).toThrow("closed");
    expect(sibling.snapshot(authority)?.entry?.sessionId).toBe("session-1");
    const replacement = await acquireRegistered();
    expect(replacement.snapshot(authority)?.entry).toBeUndefined();
    expect(() => actor.snapshot(authority)).toThrow("closed");
  });

  it.each(["database", "all"] as const)(
    "closes %s owners and reacquires empty state",
    async (scope) => {
      const actor = await acquireRegistered();
      const otherDatabase = { agentId: "main", path: "/synthetic/other-incognito" };
      const other = await acquireRegistered(otherDatabase);
      await initialize(actor);
      await initialize(other);
      const owner = memorySessionActorOwners.read(database)!;
      if (scope === "database") {
        memorySessionActorOwners.closeDatabase(database);
      } else {
        memorySessionActorOwners.reset();
      }
      expect(memorySessionActorOwners.read(database)).toBeUndefined();
      expect(() => actor.snapshot(authority)).toThrow("closed");
      await expect(owner.acquire(actor.target, lifetime)).rejects.toThrow("closed");
      if (scope === "database") {
        expect(other.snapshot(authority)?.entry?.sessionId).toBe("session-1");
      } else {
        expect(() => other.snapshot(authority)).toThrow("closed");
      }
      const replacement = await acquireRegistered();
      expect(replacement.snapshot(authority)?.entry).toBeUndefined();
    },
  );
});

describe("memory actor effect adapters", () => {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:incognito-effects",
    storePath: "/synthetic/effects",
    sessionId: "session-1",
  };
  const registryTargets: Array<{ agentId: string; path: string }> = [];

  afterEach(() => {
    for (const target of registryTargets.splice(0)) {
      memorySessionActorOwners.closeDatabase(target);
    }
    vi.unstubAllEnvs();
  });

  function unboundFixture(name: string, fields: Partial<SessionEntry> = {}) {
    const env = { OPENCLAW_STATE_DIR: `/synthetic/${name}-effect` };
    const target = {
      agentId: scope.agentId,
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: scope.agentId, env }),
    };
    registryTargets.push(target);
    const source = { ...scope, env, storePath: target.path };
    const entry: SessionEntry = {
      sessionId: source.sessionId,
      updatedAt: 1,
      incognito: true,
      ...fields,
    };
    const upsert = (patch: Partial<SessionEntry> = {}) =>
      upsertSessionEntryCore(source, { ...entry, ...patch });
    return { source, target, entry, upsert };
  }

  async function effectFixture() {
    const { owner, actor } = await openFixture(
      scope.sessionKey,
      createMemorySessionActorOwner({ agentId: scope.agentId, path: scope.storePath }),
    );
    const binding = { actor, authority, agentId: scope.agentId, path: scope.storePath };
    const storage = memoryStorage(actor.storage!);
    await storage.commit("session.entry.create", {
      entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true, sandboxMode: "off" },
    });
    const patch = async (value: Partial<InternalSessionEntry>) =>
      storage.commit("session.entry.patch", { operation: { kind: "fields", patch: value } });
    return {
      owner,
      actor,
      patch,
      run: <T>(callback: () => T) => runWithSessionActorStorage(binding, callback),
    };
  }

  it("publishes lifecycle failure facts with the memory entry commit", async () => {
    const f = await effectFixture();
    await f.patch({ lifecycleRunId: "failed-run", startedAt: 1_000 });
    const onCommitted = vi.fn();
    const result = await f.run(() =>
      applySessionEntryOperation(
        scope,
        {
          kind: "lifecycle",
          lifecycle: {
            canonicalKey: scope.sessionKey,
            currentLifecycleGeneration: "test-generation",
            exactCronRun: false,
            lastRunError: "Provider disconnected",
            event: {
              sessionId: scope.sessionId,
              runId: "failed-run",
              ts: 2_000,
              data: { phase: "error", error: "Provider disconnected", endedAt: 2_000 },
            },
          },
        },
        { skipMaintenance: true, onCommitted },
      ),
    );
    expect(result).toMatchObject({ status: "failed", lastRunId: "failed-run" });
    expect(f.actor.snapshot(authority)?.entry).toEqual(result);
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(result, undefined, {
      failedRun: {
        runId: "failed-run",
        error: "Provider disconnected",
        errorKind: undefined,
        suppressErrorNotice: false,
      },
    });
  });

  it("acquires an input handle without transferring the caller's actor lifetime", async () => {
    const f = await effectFixture();
    const input = await f.run(() =>
      acquireSessionInputActor(
        {
          agentId: scope.agentId,
          storePath: scope.storePath,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        },
        lifetime,
      ),
    );
    expect(input?.actor.target).toEqual(f.actor.target);
    await input!.actor.release();
    await f.patch({ label: "Still open" });
    expect(f.actor.snapshot(authority)?.entry?.label).toBe("Still open");
  });

  it("refuses steering after its in-process owner closes", async () => {
    const f = await effectFixture();
    const delivery = f.run(() =>
      prepareSteeringDelivery({
        ...scope,
        assertCurrent() {},
      }),
    );
    await delivery.prepareCurrent();
    f.owner.close();
    await expect(delivery.prepareCurrent()).rejects.toThrow("closed");
  });

  it("reads unbound delivery settings and refuses a closed actor after same-key recreation", async () => {
    const { source, target, upsert } = unboundFixture("delivery");
    const facts = { ...source, lifecycleRevision: null };
    await expect(prepareSessionGenerationFacts(facts)).rejects.toThrow("no longer accepts");
    expect(memorySessionActorOwners.read(target)).toBeUndefined();
    await upsert();
    const delivery = await prepareSessionGenerationFacts(facts);
    const effect = await prepareSessionDeliveryGeneration(facts);
    try {
      await upsert({
        permissionMode: "guarded",
        toolOverrides: { webSearch: false },
      });
      expect(delivery.readSessionSettings()).toEqual({
        permissionMode: "guarded",
        toolOverrides: { webSearch: false },
      });
      await runSessionMutation({
        scope: source.storePath,
        identities: [source.sessionKey, source.sessionId],
        async run() {
          expect(() => effect.assertCurrent()).toThrow("unavailable");
        },
      });
      effect.assertCurrent();
      memorySessionActorOwners.closeSession(target, source.sessionKey);
      await upsert();
      expect(() => delivery.assertCurrent()).toThrow("unavailable");
      expect(() => effect.assertCurrent()).toThrow("unavailable");
    } finally {
      effect.release();
      delivery.release();
    }
  });

  it("rejects an unbound reply caller when sandbox policy changes before the tool effect", async () => {
    const { source, target, upsert } = unboundFixture("reply-tool", { sandboxMode: "off" });
    vi.stubEnv("OPENCLAW_STATE_DIR", source.env.OPENCLAW_STATE_DIR);
    await upsert();
    const route = { provider: "openai", model: "test-model" };
    const reply = prepareReplyToolAuthority({
      run: {
        ...route,
        ...source,
        sessionFile: "/synthetic/session",
        workspaceDir: "/synthetic/workspace",
        senderIsOwner: true,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
      },
    });
    const fingerprint = await reply.fingerprintAsync(route);
    const prepared = await prepareReplyToolAuthorityCallerRead(
      reply.projectAsync,
      undefined,
      fingerprint,
      route,
      () => {},
    );
    expect(prepared).toBeDefined();
    prepared!.assertPrepared([]);
    await upsert({ sandboxMode: undefined });
    expect(() => prepared!.assertPrepared([])).toThrow("policy does not match");
    memorySessionActorOwners.closeDatabase(target);
    expect(() => prepared!.assertPrepared([])).toThrow("closed");
  });

  it("keeps unbound reset cleanup on the accepted session after a replacement", async () => {
    const { source, target, entry, upsert } = unboundFixture("reset-cleanup", {
      lifecycleRevision: "accepted-reset",
    });
    await upsert();
    const guard = await prepareSessionResetCleanupGuard({
      ...source,
      expectedSession: entry,
    });
    guard.assertCurrent();
    await upsert({ label: "Unrelated edit" });
    guard.assertCurrent();
    await upsert({
      sessionId: "replacement-session",
      lifecycleRevision: "replacement-reset",
    });
    expect(() => guard.assertCurrent()).toThrow("session changed before cleanup");
    memorySessionActorOwners.closeDatabase(target);
    expect(() => guard.assertCurrent()).toThrow("closed");
    guard.release();
  });

  it("checks current requester lineage after a child is reparented", async () => {
    const f = await effectFixture();
    const childKey = "agent:main:dashboard:incognito-child";
    const child = await f.actor.storage!.acquire(childKey, lifetime);
    const storage = memoryStorage(child.storage!);
    await storage.commit("session.entry.create", {
      entry: {
        sessionId: "child-1",
        updatedAt: 1,
        incognito: true,
        spawnedBy: scope.sessionKey,
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
      },
    });
    const lineage = f.run(() =>
      createCompletionGrantLineageAdmission({
        cfg: {},
        context: {
          sessionKey: scope.sessionKey,
          sessionId: scope.sessionId,
          modelProvider: "openai",
          modelId: "test-model",
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: childKey,
            sourceTool: "subagent_announce",
          },
          trustedInternalHandoff: {
            kind: "subagent-completion",
            sourceSessionKey: childKey,
            targetSessionKey: scope.sessionKey,
            targetSessionId: scope.sessionId,
            provider: "openai",
            model: "test-model",
          },
        },
      }),
    );
    const prepared = await lineage.admission!.prepare();
    expect(prepared.isCurrent()).toBe(true);
    await storage.commit("session.entry.patch", {
      operation: {
        kind: "fields",
        patch: { spawnedBy: "agent:main:dashboard:incognito-other" },
      },
    });
    expect(prepared.isCurrent()).toBe(false);
    expect(() => prepared.current!.assertCurrent([])).toThrow("requester policy");
  });
});

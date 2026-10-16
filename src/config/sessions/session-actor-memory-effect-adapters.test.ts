import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareReplyToolAuthorityCallerRead } from "../../agents/harness/host-private-capabilities.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { prepareSessionResetCleanupGuard } from "../../auto-reply/reply/session-reset-cleanup.js";
import { prepareSteeringDelivery } from "../../auto-reply/reply/steering-delivery-preparation.js";
import { createCompletionGrantLineageAdmission } from "../../gateway/tool-resolution-completion.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { applySessionEntryOperation } from "./session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { memoryStorage } from "./session-actor-memory-publication.test-support.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import {
  prepareSessionDeliveryGeneration,
  prepareSessionGenerationFacts,
} from "./session-delivery-generation.js";
import { acquireSessionInputActor } from "./session-input-actor.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory effect opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory effect allocated a worker");
  }),
}));

const scope = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:incognito-effects",
  storePath: "/synthetic/effects",
  sessionId: "session-1",
};
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
const registryTargets: Array<{ agentId: string; path: string }> = [];

afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
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

async function fixture() {
  const owner = createMemorySessionActorOwner({ agentId: scope.agentId, path: scope.storePath });
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: scope.sessionKey },
    lifetime,
  );
  const binding = { actor, authority, agentId: scope.agentId, path: scope.storePath };
  const storage = memoryStorage(actor.storage!);
  await storage.commit("session.entry.create", {
    entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true, sandboxMode: "off" },
  });
  const patch = async (value: Partial<InternalSessionEntry>) =>
    storage.commit("session.entry.patch", { operation: { kind: "fields", patch: value } });
  return { owner, actor, binding, patch };
}

describe("memory actor effect adapters", () => {
  it("publishes lifecycle failure facts with the memory entry commit", async () => {
    const f = await fixture();
    await f.patch({ lifecycleRunId: "failed-run", startedAt: 1_000 });
    const onCommitted = vi.fn();
    const result = await runWithSessionActorStorage(f.binding, () =>
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
    const f = await fixture();
    const input = await runWithSessionActorStorage(f.binding, () =>
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

  it("reads terminal steering eligibility after an awaited in-process write", async () => {
    const f = await fixture();
    const delivery = runWithSessionActorStorage(f.binding, () =>
      prepareSteeringDelivery({
        ...scope,
        sourceTurnId: "source-turn",
        assertCurrent() {},
      }),
    );
    await delivery.prepareCurrent();
    await f.patch({ restartRecoveryDeliveryReceiptState: "terminal-pending" });
    await expect(delivery.prepareCurrent()).rejects.toThrow("terminal-pending");
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
      await runExclusiveSessionLifecycleMutation("reset", {
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
    const f = await fixture();
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
    const lineage = runWithSessionActorStorage(f.binding, () =>
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

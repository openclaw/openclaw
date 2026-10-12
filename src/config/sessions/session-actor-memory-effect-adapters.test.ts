import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareReplyToolAuthorityCallerRead } from "../../agents/harness/host-private-capabilities.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { prepareSteeringDelivery } from "../../auto-reply/reply/steering-delivery-preparation.js";
import { createCompletionGrantLineageAdmission } from "../../gateway/tool-resolution-completion.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";
import { acquireSessionInputActor } from "./session-input-actor.js";
import type { SessionEntry } from "./types.js";

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

afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

async function fixture() {
  const owner = createMemorySessionActorOwner({ agentId: scope.agentId, path: scope.storePath });
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: scope.sessionKey },
    lifetime,
  );
  const binding = { actor, authority, agentId: scope.agentId, path: scope.storePath };
  readSessionActorStorageResult(
    await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true, sandboxMode: "off" },
        },
      },
      authority,
    ),
  );
  const patch = async (value: Partial<SessionEntry>) =>
    readSessionActorStorageResult(
      await actor.storage!.mutate(
        {
          type: "session.entry.patch",
          input: { operation: { kind: "fields", patch: value } },
        },
        authority,
      ),
    );
  return { owner, actor, binding, patch };
}

describe("memory actor effect adapters", () => {
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

  it("reads live delivery settings and refuses a closed actor after same-key recreation", async () => {
    const f = await fixture();
    const delivery = await runWithSessionActorStorage(f.binding, () =>
      prepareSessionGenerationFacts({
        ...scope,
        lifecycleRevision: null,
      }),
    );
    await f.patch({ permissionMode: "guarded", toolOverrides: { webSearch: false } });
    expect(delivery.readSessionSettings()).toEqual({
      permissionMode: "guarded",
      toolOverrides: { webSearch: false },
    });
    f.owner.closeSession(scope.sessionKey);
    const replacement = await f.owner.acquire(
      { database: f.owner.identity, sessionKey: scope.sessionKey },
      lifetime,
    );
    expect(replacement.snapshot(authority)?.entry).toBeUndefined();
    expect(() => delivery.assertCurrent()).toThrow("unavailable");
    delivery.release();
  });

  it("rejects a prepared reply caller when sandbox policy changes before the tool effect", async () => {
    const f = await fixture();
    const route = { provider: "openai", model: "test-model" };
    const reply = runWithSessionActorStorage(f.binding, () =>
      prepareReplyToolAuthority({
        run: {
          ...route,
          ...scope,
          sessionFile: "/synthetic/session",
          workspaceDir: "/synthetic/workspace",
          senderIsOwner: true,
          config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        },
      }),
    );
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
    await f.patch({ sandboxMode: undefined });
    expect(() => prepared!.assertPrepared([])).toThrow("policy does not match");
    f.owner.close();
    expect(() => prepared!.assertPrepared([])).toThrow("closed");
  });

  it("checks current requester lineage after a child is reparented", async () => {
    const f = await fixture();
    const childKey = "agent:main:dashboard:incognito-child";
    const child = await f.actor.storage!.acquire(childKey, lifetime);
    readSessionActorStorageResult(
      await child.storage!.mutate(
        {
          type: "session.entry.create",
          input: {
            entry: {
              sessionId: "child-1",
              updatedAt: 1,
              incognito: true,
              spawnedBy: scope.sessionKey,
              spawnDepth: 1,
              inheritedToolPolicyVersion: 1,
            },
          },
        },
        authority,
      ),
    );
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
    expect(lineage.isCurrent()).toBe(true);
    readSessionActorStorageResult(
      await child.storage!.mutate(
        {
          type: "session.entry.patch",
          input: {
            operation: {
              kind: "fields",
              patch: { spawnedBy: "agent:main:dashboard:incognito-other" },
            },
          },
        },
        authority,
      ),
    );
    expect(lineage.isCurrent()).toBe(false);
    expect(() => prepared.current!.assertCurrent([])).toThrow("requester policy");
  });
});

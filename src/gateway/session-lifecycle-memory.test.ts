import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { readSessionCreateTarget } from "./session-create-target.js";
import { deleteIncognitoSessionForReset } from "./session-reset-incognito.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory session lifecycle opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory session lifecycle allocated a worker");
  }),
}));

const key = "agent:main:dashboard:incognito-lifecycle";
const path = "/synthetic/lifecycle/agents/main/agent/incognito-openclaw-agent.sqlite";
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const cfg = { agents: { entries: { main: {} } } };

afterEach(() => memorySessionActorOwners.closeDatabase({ agentId: "main", path }));

async function fixture() {
  const owner = memorySessionActorOwners.get({ agentId: "main", path });
  const actor = await owner.acquire({ database: owner.identity, sessionKey: key }, lifetime);
  const storage = actor.storage!;
  const entry = {
    sessionId: "original",
    lifecycleRevision: "lifecycle",
    updatedAt: 1,
    incognito: true as const,
  };
  const result = await storage.mutate(
    {
      type: "session.entry.create",
      input: {
        entry,
      },
    },
    authority,
  );
  expect(result.kind).toBe("committed");
  return { owner, actor, storage, entry, binding: { actor, authority, agentId: "main", path } };
}

it("reads committed actor changes through Gateway target and creation preparation", async () => {
  const { binding, storage } = await fixture();
  await runWithSessionActorStorage(binding, async () => {
    const target = await resolveGatewaySessionStoreTargetInWorker({ cfg, key, agentId: "main" });
    await storage.mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { displayName: "Current title" } } },
      },
      authority,
    );
    expect(loadGatewaySessionEntryReadOnly(key, { agentId: "main" }, cfg).entry?.displayName).toBe(
      "Current title",
    );
    expect(
      await readSessionCreateTarget({ cfg, commandSource: "test" }, target, "original", [key]),
    ).toMatchObject({ ok: true, value: { displayName: "Current title" } });
  });
});

it("resets the selected session after cleanup writes metadata without requiring its old row", async () => {
  const { binding, storage, owner, entry } = await fixture();
  const result = await runWithSessionActorStorage(binding, () =>
    deleteIncognitoSessionForReset({
      key,
      agentId: "main",
      storePath: path,
      target: { canonicalKey: key, storeKeys: [key] },
      entry,
      commitGuard() {},
      async beforeDelete() {
        await storage.mutate(
          {
            type: "session.entry.patch",
            input: {
              operation: {
                kind: "fields",
                patch: { displayName: "Cleanup complete", updatedAt: 2 },
              },
            },
          },
          authority,
        );
      },
    }),
  );
  expect(result).toEqual({ ok: true, value: { deletedSessionId: "original" } });
  expect(owner.readSession(key, authority)).toBeUndefined();
});

it("checks live deletion authority after asynchronous cleanup", async () => {
  const { binding, owner, entry } = await fixture();
  let allowed = true;
  await expect(
    runWithSessionActorStorage(binding, () =>
      deleteIncognitoSessionForReset({
        key,
        agentId: "main",
        storePath: path,
        target: { canonicalKey: key, storeKeys: [key] },
        entry,
        commitGuard() {
          if (!allowed) {
            throw new Error("Deletion authority revoked");
          }
        },
        async beforeDelete() {
          allowed = false;
        },
      }),
    ),
  ).rejects.toThrow("Deletion authority revoked");
  expect(owner.readSession(key, authority)?.entry?.sessionId).toBe("original");
});

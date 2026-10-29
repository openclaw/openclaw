import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { deleteIncognitoSessionForReset } from "./session-reset-incognito.js";

// Durable publication receipts have their own owner; this suite isolates memory lifecycle.
vi.mock("../state/github-personal-publication-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/github-personal-publication-lifecycle.js")>()),
  preparePersonalGitHubSessionReceiptDeletion: async () => async () => {},
}));
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

afterEach(() => {
  memorySessionActorOwners.closeDatabase({ agentId: "main", path });
  vi.unstubAllEnvs();
});

async function fixture() {
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/lifecycle");
  const owner = memorySessionActorOwners.get({ agentId: "main", path });
  const actor = await owner.acquire({ database: owner.identity, sessionKey: key }, lifetime);
  const storage = actor.storage!;
  const entry = {
    sessionId: "original",
    lifecycleRevision: "lifecycle",
    updatedAt: 1,
    incognito: true as const,
  };
  expect(
    (await storage.mutate({ type: "session.entry.create", input: { entry } }, authority)).kind,
  ).toBe("committed");
  return {
    owner,
    patch: (patch: Partial<SessionEntry>) =>
      storage.mutate(
        { type: "session.entry.patch", input: { operation: { kind: "fields", patch } } },
        authority,
      ),
    reset: {
      key,
      agentId: "main",
      storePath: path,
      target: { canonicalKey: key, storeKeys: [key] },
      entry,
      commitGuard() {},
    },
  };
}

it("resets after cleanup updates actor metadata", async () => {
  const { patch, owner, reset } = await fixture();
  expect(
    await deleteIncognitoSessionForReset({
      ...reset,
      beforeDelete: async () => {
        await patch({ displayName: "Cleanup complete", updatedAt: 2 });
      },
    }),
  ).toEqual({ ok: true, value: { deletedSessionId: "original" } });
  expect(owner.readSession(key, authority)).toBeUndefined();
});

it("preserves the actor when cleanup revokes deletion authority", async () => {
  const { owner, reset } = await fixture();
  let allowed = true;
  const pending = deleteIncognitoSessionForReset({
    ...reset,
    commitGuard() {
      if (!allowed) {
        throw new Error("Deletion authority revoked");
      }
    },
    async beforeDelete() {
      allowed = false;
    },
  });
  await expect(pending).rejects.toThrow("Deletion authority revoked");
  expect(owner.readSession(key, authority)?.entry?.sessionId).toBe("original");
});

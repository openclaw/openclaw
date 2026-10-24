import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { readSessionCreateTarget } from "./session-create-target.js";
import { deleteIncognitoSessionForReset } from "./session-reset-incognito.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";

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
const cfg = { agents: { entries: { main: {} } } };

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
  const result = await storage.mutate(
    { type: "session.entry.create", input: { entry } },
    authority,
  );
  expect(result.kind).toBe("committed");
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

it("reads committed actor changes through Gateway target and creation preparation", async () => {
  const { patch } = await fixture();
  const target = await resolveGatewaySessionStoreTargetInWorker({ cfg, key, agentId: "main" });
  await patch({ displayName: "Current title" });
  expect(
    (await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" }, cfg)).entry?.displayName,
  ).toBe("Current title");
  expect(
    await readSessionCreateTarget({ cfg, commandSource: "test" }, target, "original", [key]),
  ).toMatchObject({ ok: true, value: { displayName: "Current title" } });
});

it.each(["metadata update", "authority revocation"])(
  "resets after cleanup: %s",
  async (cleanup) => {
    const { patch, owner, reset } = await fixture();
    const revoked = cleanup === "authority revocation";
    let allowed = true;
    const pending = deleteIncognitoSessionForReset({
      ...reset,
      commitGuard() {
        if (!allowed) {
          throw new Error("Deletion authority revoked");
        }
      },
      async beforeDelete() {
        if (revoked) {
          allowed = false;
        } else {
          await patch({ displayName: "Cleanup complete", updatedAt: 2 });
        }
      },
    });
    if (revoked) {
      await expect(pending).rejects.toThrow("Deletion authority revoked");
      expect(owner.readSession(key, authority)?.entry?.sessionId).toBe("original");
    } else {
      expect(await pending).toEqual({ ok: true, value: { deletedSessionId: "original" } });
      expect(owner.readSession(key, authority)).toBeUndefined();
    }
  },
);

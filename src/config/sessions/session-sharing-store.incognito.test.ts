import "../../test-utils/prepare-compiled-subprocesses.js";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareSteeringDelivery } from "../../auto-reply/reply/steering-delivery-preparation.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
} from "./restart-recovery-receipt.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { withSessionActorStorage } from "./session-actor-storage-binding.js";
import type { SessionActorStorageCommand } from "./session-actor-storage-contract.js";
import { prepareSessionDeliveryGeneration } from "./session-delivery-generation.js";
import { addSessionSuggestionInWorker } from "./session-metadata-write.async.js";
import { addSessionMember, readSessionMembersInWorker } from "./session-sharing-store.js";
import { listSessionSuggestions } from "./session-suggestion-store.read.js";
import type { SessionEntry } from "./types.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Incognito collaboration opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Incognito collaboration allocated a worker");
  }),
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/incognito-collaboration" };
const cfg = { agents: { entries: { main: {} } } };
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const location = {
  agentId: "main",
  path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
});
afterEach(() => {
  memorySessionActorOwners.closeDatabase(location);
  vi.unstubAllEnvs();
  expect(DatabaseSync).not.toHaveBeenCalled();
  expect(Worker).not.toHaveBeenCalled();
});

function scopeFor(name: string) {
  return {
    agentId: location.agentId,
    storePath: location.path,
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    env,
  };
}

async function mutate(scope: ReturnType<typeof scopeFor>, command: SessionActorStorageCommand) {
  const result = await withSessionActorStorage(
    scope,
    { lifetime, authority, create: command.type === "session.entry.create" },
    ({ actor }) => actor.storage.mutate(command, authority),
  );
  expect(result?.kind).toBe("committed");
}

it("keeps unbound absent collaboration reads empty without allocating an owner", async () => {
  const scope = scopeFor("absent");
  expect(await readSessionMembersInWorker(scope)).toEqual({ entry: undefined, members: [] });
  expect(await listSessionSuggestions(scope)).toEqual([]);
  await expect(
    addSessionMember(scope, { identityId: "reader", addedBy: "owner" }),
  ).rejects.toThrow();
  await expect(
    addSessionSuggestionInWorker(scope, { authorId: "reader", text: "Missing session" }),
  ).rejects.toThrow();
  const delivery = { ...scope, sessionId: "absent", sourceTurnId: "source", toolCallId: "send" };
  expect(await beginRestartRecoveryTerminalDelivery(delivery)).toBe("stale");
  expect(await completeRestartRecoveryTerminalDelivery(delivery)).toBe("stale");
  expect(await cancelRestartRecoveryTerminalDelivery(delivery)).toBe("stale");
  expect(memorySessionActorOwners.read(location)).toBeUndefined();
});

it("shares current unbound memory facts across sharing, delivery and steering", async () => {
  const scope = scopeFor("composition");
  const entry = {
    sessionId: "composition",
    lifecycleRevision: "composition",
    updatedAt: 1,
    incognito: true,
  } satisfies SessionEntry;
  await mutate(scope, { type: "session.entry.create", input: { entry } });
  const owner = memorySessionActorOwners.read(location)!;
  expect(owner).toBeDefined();
  const facts = await prepareSessionMutationFacts({ cfg, ...scope });
  const delivery = await prepareSessionDeliveryGeneration({
    ...scope,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
  });
  try {
    expect(facts.storageTarget.storePath).toBe(location.path);
    expect(facts.readCurrent(cfg).target?.entry.sessionId).toBe(entry.sessionId);
    delivery.assertCurrent();

    await addSessionMember(scope, { identityId: "viewer", addedBy: "owner" });
    expect(facts.readCurrent(cfg).membership.has("viewer")).toBe(true);
    delivery.assertCurrent();
    const steering = prepareSteeringDelivery({
      ...scope,
      sessionId: entry.sessionId,
      assertCurrent() {},
    });
    await steering.prepareCurrent();
    await mutate(scope, {
      type: "session.entry.patch",
      input: {
        operation: {
          kind: "fields",
          patch: { restartRecoveryDeliveryReceiptState: "delivered-terminal" },
        },
      },
    });
    await expect(steering.prepareCurrent()).rejects.toThrow("delivered-terminal");

    owner.closeSession(scope.sessionKey);
    expect(() => facts.readCurrent(cfg)).toThrow("Session access facts are unavailable");
    expect(() => delivery.assertCurrent()).toThrow(/Session delivery generation/);
    await expect(steering.prepareCurrent()).rejects.toThrow("closed");
  } finally {
    delivery.release();
    facts.release();
  }
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "../config/sessions/session-actor-storage-contract.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import * as deletion from "./server-methods/sessions-delete.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { startIncognitoSessionLifetime } from "./session-incognito-lifetime.js";

// These adapters must not allocate persistence or consume database-worker capacity.
vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory lifetime opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory lifetime allocated a worker");
  }),
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/incognito-lifetime" };
const authority: SessionActorStorageAuthority = { assertCurrent() {}, authorize() {} };
const actors: SessionActor[] = [];
const sessionKey = "agent:main:dashboard:incognito-expiry";
const day = 24 * 60 * 60_000;

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
});

afterEach(async () => {
  await Promise.all(actors.splice(0).map((actor) => actor.release()));
  memorySessionActorOwners.reset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createSession(createdAt: number, key = sessionKey, sessionId = "original") {
  const agentId = key.split(":")[1]!;
  const owner = memorySessionActorOwners.get({
    agentId,
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
  });
  const actor = await owner.acquire(
    { sessionKey: key, database: owner.identity },
    { assertCurrent() {}, assertReadable() {} },
  );
  actors.push(actor);
  const created = await actor.storage!.mutate(
    {
      type: "session.entry.create",
      input: { entry: { sessionId, updatedAt: createdAt, createdAt, incognito: true } },
    },
    authority,
  );
  expect(created.kind).toBe("committed");
  sessionChanges.emit({ agentId, sessionKey: key, storePath: owner.path });
  return { owner, actor };
}

async function deleteSession(params: Parameters<typeof deletion.deleteGatewaySession>[0]) {
  const binding = getSessionActorStorageBinding({ sessionKey: params.params.key });
  if (!binding) {
    throw new Error("Missing memory binding");
  }
  params.assertCurrent?.();
  const result = await binding.actor.storage!.mutate(
    {
      type: "session.lifecycle.delete",
      input: { expectedSessionId: params.params.expectedSessionId },
    },
    binding.authority,
  );
  expect(result).toMatchObject({ kind: "committed", value: { deleted: true } });
  return {
    ok: true as const,
    result: { ok: true as const, key: params.params.key, deleted: true, archived: [] },
  };
}

it("observes startup and publications without creating a memory owner", async () => {
  const time = createGatewaySchedulerClock(1_000);
  const scheduler = createTestGatewayScheduler(time.clock);
  const deleteGatewaySession = vi.spyOn(deletion, "deleteGatewaySession");
  const sidecar = startIncognitoSessionLifetime({
    context: {} as GatewayRequestContext,
    scheduler,
    logWarning: vi.fn(),
  });
  try {
    sessionChanges.emit({
      agentId: "main",
      sessionKey,
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    });
    await time.advanceBy(day);
    expect(memorySessionActorOwners.list()).toEqual([]);
    expect(deleteGatewaySession).not.toHaveBeenCalled();
  } finally {
    await sidecar.stop();
    await scheduler.stop();
  }
});

it("keeps the creation deadline after activity and joins accepted expiry before shutdown", async () => {
  const time = createGatewaySchedulerClock(1_000);
  const scheduler = createTestGatewayScheduler(time.clock);
  const { owner, actor } = await createSession(time.clock.now());
  const started = createDeferredCore();
  const release = createDeferredCore();
  const order: string[] = [];
  const logWarning = vi.fn();
  vi.spyOn(deletion, "deleteGatewaySession").mockImplementation(async (params) => {
    started.resolve();
    await release.promise;
    const result = await deleteSession(params);
    order.push("deleted");
    return result;
  });
  const sidecar = startIncognitoSessionLifetime({
    context: {} as GatewayRequestContext,
    scheduler,
    logWarning,
  });
  let waking: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await time.advanceBy(day - 1);
    const patched = await actor.storage!.mutate(
      {
        type: "session.entry.patch",
        input: {
          operation: {
            kind: "fields",
            patch: { createdAt: time.clock.now(), updatedAt: time.clock.now() },
          },
        },
      },
      authority,
    );
    expect(patched.kind).toBe("committed");
    sessionChanges.emit({ agentId: owner.agentId, storePath: owner.path, sessionKey });
    expect(actor.snapshot(authority)?.entry?.createdAt).toBe(1_000);
    waking = Promise.resolve(time.advanceBy(1));
    await started.promise;
    stopping = Promise.resolve(sidecar.stop()).then(() => {
      order.push("stopped");
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    release.resolve();
    await waking;
    await stopping;
    expect(order).toEqual(["deleted", "stopped"]);
    expect(owner.readSession(sessionKey, authority)).toBeUndefined();
    expect(logWarning).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await waking;
    await stopping;
    await sidecar.stop();
    await scheduler.stop();
  }
});

it("retries failed cleanup without extending the original lifetime", async () => {
  const time = createGatewaySchedulerClock(1_000);
  const scheduler = createTestGatewayScheduler(time.clock);
  const { owner } = await createSession(time.clock.now());
  const logWarning = vi.fn();
  let attempts = 0;
  vi.spyOn(deletion, "deleteGatewaySession").mockImplementation(async (params) => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("Transient cleanup failure");
    }
    return deleteSession(params);
  });
  const sidecar = startIncognitoSessionLifetime({
    context: {} as GatewayRequestContext,
    scheduler,
    logWarning,
  });
  try {
    await time.advanceBy(day);
    expect(owner.readSession(sessionKey, authority)?.entry?.sessionId).toBe("original");
    expect(logWarning).toHaveBeenCalledExactlyOnceWith(
      "Incognito session expiry could not finish cleanup; will retry.",
    );
    await time.advanceBy(60_000);
    expect(owner.readSession(sessionKey, authority)).toBeUndefined();
    expect(attempts).toBe(2);
  } finally {
    await sidecar.stop();
    await scheduler.stop();
  }
});

it("follows new memory owners without expiring a replacement at its predecessor's deadline", async () => {
  const time = createGatewaySchedulerClock(1_000);
  const scheduler = createTestGatewayScheduler(time.clock);
  const first = await createSession(time.clock.now());
  const deleted: string[] = [];
  vi.spyOn(deletion, "deleteGatewaySession").mockImplementation(async (params) => {
    const result = await deleteSession(params);
    deleted.push(params.params.expectedSessionId!);
    return result;
  });
  const logWarning = vi.fn();
  const sidecar = startIncognitoSessionLifetime({
    context: {} as GatewayRequestContext,
    scheduler,
    logWarning,
  });
  try {
    await time.advanceBy(60_000);
    memorySessionActorOwners.closeDatabase(first.owner);
    await createSession(time.clock.now(), sessionKey, "replacement");
    await createSession(time.clock.now(), "agent:work:dashboard:incognito-expiry", "other-agent");
    await time.advanceBy(day - 60_000);
    expect(deleted).toEqual([]);
    await time.advanceBy(60_000);
    expect(deleted.toSorted()).toEqual(["other-agent", "replacement"]);
    expect(logWarning).not.toHaveBeenCalled();
  } finally {
    await sidecar.stop();
    await scheduler.stop();
  }
});

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
import { attachInitialGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";
import * as deletion from "./server-methods/sessions-delete.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
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

// mock-isolation: Keep unrelated OAuth state outside the memory lifetime startup fixture.
vi.mock("./github-oauth-lifecycle.js", () => ({
  createGitHubOAuthLifecycle: () => ({ start() {}, async stop() {} }),
  installActiveGitHubOAuthLifecycle: () => () => {},
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/incognito-lifetime" };
const authority: SessionActorStorageAuthority = { assertCurrent() {}, authorize() {} };
const actors: SessionActor[] = [];
const sessionKey = "agent:main:dashboard:incognito-expiry";
const day = 24 * 60 * 60_000;
const memoryPath = (agentId = "main") => resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
let time: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let sidecar: { stop(): Promise<void> | void } | undefined;
let logWarning: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  time = createGatewaySchedulerClock(1_000);
  scheduler = createTestGatewayScheduler(time.clock);
  logWarning = vi.fn();
  sidecar = undefined;
});

afterEach(async () => {
  await sidecar?.stop();
  await scheduler.stop();
  await Promise.all(actors.splice(0).map((actor) => actor.release()));
  memorySessionActorOwners.reset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function startLifetime() {
  return (sidecar = startIncognitoSessionLifetime({
    context: {} as GatewayRequestContext,
    scheduler,
    logWarning,
  }));
}

async function createSession(createdAt: number, key = sessionKey, sessionId = "original") {
  const agentId = key.split(":")[1]!;
  const owner = memorySessionActorOwners.get({
    agentId,
    path: memoryPath(agentId),
  });
  const actor = await owner.acquire(
    { sessionKey: key, database: owner.identity },
    { assertCurrent() {}, assertReadable() {} },
  );
  actors.push(actor);
  const entry = { sessionId, updatedAt: createdAt, createdAt, incognito: true };
  const created = await actor.storage!.mutate(
    { type: "session.entry.create", input: { entry } },
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
  const deleteGatewaySession = vi.spyOn(deletion, "deleteGatewaySession");
  startLifetime();
  sessionChanges.emit({ agentId: "main", sessionKey, storePath: memoryPath() });
  await time.advanceBy(day);
  expect(memorySessionActorOwners.list()).toEqual([]);
  expect(deleteGatewaySession).not.toHaveBeenCalled();
});

it("keeps the creation deadline after activity and joins accepted expiry before shutdown", async () => {
  const { owner, actor } = await createSession(time.clock.now());
  const started = createDeferredCore();
  const release = createDeferredCore();
  const order: string[] = [];
  vi.spyOn(deletion, "deleteGatewaySession").mockImplementation(async (params) => {
    started.resolve();
    await release.promise;
    const result = await deleteSession(params);
    order.push("deleted");
    return result;
  });
  const lifetime = startLifetime();
  let waking: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await time.advanceBy(day - 1);
    const patch = { createdAt: time.clock.now(), updatedAt: time.clock.now() };
    const patched = await actor.storage!.mutate(
      { type: "session.entry.patch", input: { operation: { kind: "fields", patch } } },
      authority,
    );
    expect(patched.kind).toBe("committed");
    sessionChanges.emit({ agentId: owner.agentId, storePath: owner.path, sessionKey });
    expect(actor.snapshot(authority)?.entry?.createdAt).toBe(1_000);
    waking = Promise.resolve(time.advanceBy(1));
    await started.promise;
    stopping = Promise.resolve(lifetime.stop()).then(() => {
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
  }
});

it("retries failed cleanup without extending the original lifetime", async () => {
  const { owner } = await createSession(time.clock.now());
  const cleanup = vi
    .spyOn(deletion, "deleteGatewaySession")
    .mockRejectedValueOnce(new Error("Transient cleanup failure"))
    .mockImplementation(deleteSession);
  startLifetime();
  await time.advanceBy(day);
  expect(owner.readSession(sessionKey, authority)?.entry?.sessionId).toBe("original");
  expect(logWarning).toHaveBeenCalledExactlyOnceWith(
    "Incognito session expiry could not finish cleanup; will retry.",
  );
  await time.advanceBy(60_000);
  expect(owner.readSession(sessionKey, authority)).toBeUndefined();
  expect(cleanup).toHaveBeenCalledTimes(2);
});

it("starts memory expiry with Gateway sidecars and preserves replacement deadlines", async () => {
  const first = await createSession(time.clock.now());
  const cleanup = vi.spyOn(deletion, "deleteGatewaySession").mockImplementation(deleteSession);
  const stopOwner = createGatewaySidecarStopOwner();
  sidecar = stopOwner;
  await attachInitialGatewayLifetimeSidecars({
    scheduler,
    gatewayRequestContext: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
    chatMetadataLifecycle: { attachContext: vi.fn(async () => {}) } as never,
    minimalTestGateway: true,
    flushPendingSessionsChangedEvents: async () => {},
    logWarning,
    publishSidecars: stopOwner.publish,
  });
  await time.advanceBy(60_000);
  memorySessionActorOwners.closeDatabase(first.owner);
  await createSession(time.clock.now(), sessionKey, "replacement");
  await createSession(time.clock.now(), "agent:work:dashboard:incognito-expiry", "other-agent");
  await time.advanceBy(day - 60_000);
  expect(cleanup).not.toHaveBeenCalled();
  await time.advanceBy(60_000);
  expect(cleanup.mock.calls.map(([call]) => call.params.expectedSessionId).toSorted()).toEqual([
    "other-agent",
    "replacement",
  ]);
  expect(logWarning).not.toHaveBeenCalled();
});

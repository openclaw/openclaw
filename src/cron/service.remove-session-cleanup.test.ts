import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  applySessionEntryLifecycleMutation,
  loadExactSessionEntry,
  replaceSessionEntry as replaceSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.test-support.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import * as cronCleanup from "./service/locked.js";

const gatewayTestState = vi.hoisted(() => ({
  callGateway: vi.fn(),
  targetBySessionKey: new Map<string, { agentId: string; storePath: string }>(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: gatewayTestState.callGateway,
}));

gatewayTestState.callGateway.mockImplementation(
  async (request: {
    params: {
      key: string;
      expectedSessionId: string;
      expectedLifecycleRevision?: string;
      expectedSessionUpdatedAt?: number;
    };
  }) => {
    const { key, expectedSessionId, expectedLifecycleRevision, expectedSessionUpdatedAt } =
      request.params;
    const target = gatewayTestState.targetBySessionKey.get(key)!;
    const existing = loadExactSessionEntry({
      storePath: target.storePath,
      sessionKey: key,
    })?.entry;
    if (
      !existing ||
      existing.sessionId !== expectedSessionId ||
      existing.lifecycleRevision !== expectedLifecycleRevision ||
      existing.updatedAt !== expectedSessionUpdatedAt
    ) {
      return { deleted: false };
    }
    const result = await applySessionEntryLifecycleMutation({
      agentId: target.agentId,
      storePath: target.storePath,
      removals: [
        {
          sessionKey: key,
          expectedEntry: existing,
          expectedSessionId,
          expectedLifecycleRevision,
          expectedUpdatedAt: expectedSessionUpdatedAt,
          archiveRemovedTranscript: true,
        },
      ],
    });
    return { deleted: result.removedEntries > 0 };
  },
);

function replaceSessionEntry(...args: Parameters<typeof replaceSessionEntryCore>) {
  const target = args[0];
  if (!target.agentId || !target.storePath) {
    throw new Error("cron cleanup tests require an explicit agent and session store");
  }
  gatewayTestState.targetBySessionKey.set(target.sessionKey, {
    agentId: target.agentId,
    storePath: target.storePath,
  });
  return replaceSessionEntryCore(...args);
}

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-remove-session-cleanup-",
  fakeTimers: false,
});

afterEach(() => {
  gatewayTestState.targetBySessionKey.clear();
  closeOpenClawAgentDatabasesForTest();
});

async function createFixture() {
  const { storePath } = await makeStorePath();
  const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
  const createCron = () =>
    new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      resolveSessionStorePath: () => sessionStorePath,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
  const read = (sessionKey: string) =>
    loadExactSessionEntry({ storePath: sessionStorePath, sessionKey });
  const write = (sessionKey: string, sessionId: string) =>
    replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
  return { cron: createCron(), createCron, sessionStorePath, read, write };
}

function addJob(cron: CronService, id: string, enabled = true) {
  return cron.add({
    id,
    name: id,
    enabled,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "work" },
  });
}

describe("CronService.remove session cleanup", () => {
  let cleanupInFlight: Promise<unknown> | undefined;

  afterEach(async () => {
    // This nested hook drains writes before the parent closes SQLite and deletes stores.
    if (cleanupInFlight) {
      await Promise.allSettled([cleanupInFlight]);
      cleanupInFlight = undefined;
    }
  });

  it("does not materialize a session database when the deleted job never ran", async () => {
    const { cron, sessionStorePath } = await createFixture();
    const job = await addJob(cron, "never-ran", false);
    const sessionKey = `agent:main:cron:${job.id}`;
    const databasePath = resolveSqliteScope({
      agentId: "main",
      sessionKey,
      storePath: sessionStorePath,
    }).path!;

    expect(fs.existsSync(databasePath)).toBe(false);

    await expect(cron.remove(job.id)).resolves.toEqual({ ok: true, removed: true });

    expect(fs.existsSync(databasePath)).toBe(false);
    expect(
      listOpenClawAgentDatabasesForTest().some((database) => database.path === databasePath),
    ).toBe(false);
  });

  it("removes only the deleted isolated job's base session", async () => {
    const { cron, read, write } = await createFixture();
    const job = await addJob(cron, "deleted-job");
    const baseSessionKey = `agent:main:cron:${job.id}`;
    const runSessionKey = `${baseSessionKey}:run:retained-run`;
    const otherSessionKey = "agent:main:cron:other-job";
    await write(baseSessionKey, "base-session");
    await write(runSessionKey, "run-session");
    await write(otherSessionKey, "other-session");

    await expect(cron.remove(job.id)).resolves.toEqual({ ok: true, removed: true });

    expect(read(baseSessionKey)).toBe(undefined);
    expect(read(runSessionKey)).toMatchObject({ entry: { sessionId: "run-session" } });
    expect(read(otherSessionKey)).toMatchObject({ entry: { sessionId: "other-session" } });
  });

  it("releases the cron lock before waiting for the session lifecycle writer", async () => {
    const { cron, read, write, sessionStorePath } = await createFixture();
    const job = await addJob(cron, "contended-session-writer");
    const sessionKey = `agent:main:cron:${job.id}`;
    await write(sessionKey, "contended-session");

    const writerEntered = createDeferred();
    const releaseWriter = createDeferred();
    const resolvedSessionScope = resolveSqliteScope({
      agentId: "main",
      sessionKey,
      storePath: sessionStorePath,
    });
    const heldWriter = runExclusiveSqliteSessionWrite(
      resolvedSessionScope,
      async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
      },
      "session.transcript.batch",
    );
    await writerEntered.promise;

    const removal = cron.remove(job.id);
    let unrelatedAdded = false;
    const unrelatedAdd = cron
      .add({
        id: "unrelated-during-session-cleanup",
        name: "unrelated during session cleanup",
        enabled: true,
        schedule: { kind: "every", everyMs: 120_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "unrelated" },
      })
      .then(() => {
        unrelatedAdded = true;
      });

    try {
      await unrelatedAdd;
      expect(unrelatedAdded).toBe(true);
    } finally {
      releaseWriter.resolve();
      await heldWriter;
      await Promise.all([removal, unrelatedAdd]);
    }

    expect(read(sessionKey)).toBeUndefined();
  });

  it("reports failed session cleanup after removal and preserves the session for retry", async () => {
    const { cron, read, write } = await createFixture();
    const job = await addJob(cron, "cleanup-transport-failure", false);
    const sessionKey = `agent:main:cron:${job.id}`;
    await write(sessionKey, "transport-session");
    gatewayTestState.callGateway.mockRejectedValueOnce(new Error("Gateway disconnected"));

    await expect(cron.remove(job.id)).rejects.toThrow("Gateway disconnected");

    expect(await cron.list({ includeDisabled: true })).toEqual([]);
    expect(read(sessionKey)?.entry.sessionId).toBe("transport-session");
  });

  it("removes a base session recreated by an already-admitted run", async ({ signal }) => {
    const { cron, read, write } = await createFixture();
    const job = await addJob(cron, "active-deleted-job");
    const sessionKey = `agent:main:cron:${job.id}`;
    const marker = markCronJobActive(job.id);

    await write(sessionKey, "active-session");

    const cleanupRegistration = vi.spyOn(cronCleanup, "registerPendingCronSessionCleanup");
    onTestFinished(() => {
      cleanupRegistration.mockRestore();
    });
    await expect(cron.remove(job.id)).resolves.toEqual({
      ok: true,
      removed: true,
      sessionCleanup: "pending",
    });
    expect(read(sessionKey)).toMatchObject({
      entry: { sessionId: "active-session" },
    });
    await write(sessionKey, "late-session");
    const cleanupDone = cleanupRegistration.mock.calls.find(
      ([, registeredJobId]) => registeredJobId === job.id,
    )?.[2];
    if (!cleanupDone) {
      throw new Error("Cron cleanup completion was not registered");
    }
    cleanupInFlight = cleanupDone;
    clearCronJobActive(job.id, marker);

    // The cron owner releases pending cleanup after the real lifecycle mutation settles.
    await racePromiseWithAbortSignal(cleanupDone, signal);
    expect(cronCleanup.hasPendingCronSessionCleanupForAgent("main")).toBe(false);
    expect(read(sessionKey)).toBeUndefined();
  });

  it("fences same-id replacement across services sharing one store", async () => {
    const { cron: removingCron, createCron, read, write } = await createFixture();
    const replacementCron = createCron();
    const original = await removingCron.add({
      id: "cross-service-reused-id",
      name: "original job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "original" },
    });
    const sessionKey = `agent:main:cron:${original.id}`;
    const originalMarker = markCronJobActive(original.id);
    await write(sessionKey, "original-session");

    await removingCron.remove(original.id);
    let replacementAdded = false;
    const replacementPromise = replacementCron
      .add({
        id: original.id,
        name: "replacement job",
        enabled: true,
        schedule: { kind: "every", everyMs: 120_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "replacement" },
      })
      .then((job) => {
        replacementAdded = true;
        return job;
      });
    await replacementCron.status();
    expect(replacementAdded).toBe(false);

    clearCronJobActive(original.id, originalMarker);
    await replacementPromise;
    expect(read(sessionKey)).toBeUndefined();
    await write(sessionKey, "replacement-session");

    await Promise.resolve();
    await Promise.resolve();
    expect(read(sessionKey)).toMatchObject({
      entry: { sessionId: "replacement-session" },
    });
  });

  it("does not delete a shared main session", async () => {
    const { cron, read, write } = await createFixture();
    const job = await cron.add({
      id: "main-session-job",
      name: "main session job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "work" },
    });
    const sessionKey = "agent:main:main";
    await write(sessionKey, "main-session");

    await cron.remove(job.id);

    expect(read(sessionKey)).toMatchObject({
      entry: { sessionId: "main-session" },
    });
  });
});

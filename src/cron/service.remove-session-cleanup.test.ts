import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsDeleteParams } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  applySessionEntryLifecycleMutation,
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.test-support.js";
import { clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import * as cronCleanup from "./service/locked.js";

const gatewayTestState = vi.hoisted(() => ({
  callGateway: vi.fn(),
  targetBySessionKey: new Map<string, { agentId: string; storePath: string }>(),
}));

// mock-isolation: the in-process lifecycle fixture replaces Gateway transport with exact store operations.
vi.mock("../gateway/call.js", () => ({ callGateway: gatewayTestState.callGateway }));

gatewayTestState.callGateway.mockImplementation(
  async ({ params }: { params: SessionsDeleteParams }) => {
    const { key, expectedSessionId, expectedLifecycleRevision, expectedSessionUpdatedAt } = params;
    const target = gatewayTestState.targetBySessionKey.get(key)!;
    const existing = loadExactSessionEntry({ ...target, sessionKey: key })?.entry;
    if (
      !existing ||
      existing.sessionId !== expectedSessionId ||
      existing.lifecycleRevision !== expectedLifecycleRevision ||
      existing.updatedAt !== expectedSessionUpdatedAt
    ) {
      return { deleted: false };
    }
    const result = await applySessionEntryLifecycleMutation({
      ...target,
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

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-remove-session-cleanup-",
  fakeTimers: false,
});

afterEach(() => {
  gatewayTestState.targetBySessionKey.clear();
  closeOpenClawAgentDatabasesForTest();
});

type JobOptions = Partial<Parameters<CronService["add"]>[0]>;

async function setup(initialSession?: string, options: JobOptions = {}) {
  const { storePath } = await makeStorePath();
  const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
  const target = { agentId: "main", storePath: sessionStorePath };
  const createCron = () =>
    new CronService({
      ...cronTestDeps({ storePath, nowMs: undefined }),
      defaultAgentId: "main",
      resolveSessionStorePath: () => sessionStorePath,
      log: logger,
    });
  const read = (sessionKey: string) => loadExactSessionEntry({ ...target, sessionKey });
  const write = (sessionKey: string, sessionId: string) => {
    gatewayTestState.targetBySessionKey.set(sessionKey, target);
    return replaceSessionEntry({ ...target, sessionKey }, { sessionId, updatedAt: Date.now() });
  };
  const cron = createCron();
  const jobId = `cleanup-${initialSession ?? options.sessionTarget ?? "never-ran"}`;
  const job = await addJob(cron, jobId, options);
  const sessionKey = `agent:main:cron:${job.id}`;
  if (initialSession) {
    await write(sessionKey, initialSession);
  }
  const scope = resolveSqliteScope({ ...target, sessionKey });
  return { cron, job, sessionKey, createCron, scope, read, write };
}

function addJob(cron: CronService, id: string, overrides: JobOptions = {}) {
  return cron.add(
    cronTestInput({
      id,
      name: id,
      payload: { kind: "agentTurn", message: "work" },
      ...overrides,
    }),
  );
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
    const { cron, job, scope } = await setup(undefined, { enabled: false });
    const databasePath = scope.path!;

    expect(fs.existsSync(databasePath)).toBe(false);

    await expect(cron.remove(job.id)).resolves.toEqual({ ok: true, removed: true });

    expect(fs.existsSync(databasePath)).toBe(false);
    expect(
      listOpenClawAgentDatabasesForTest().some((database) => database.path === databasePath),
    ).toBe(false);
  });

  it("removes only the base session without holding the cron lock on the lifecycle writer", async () => {
    const { cron, job, sessionKey, read, write, scope } = await setup("contended-session");
    const runSessionKey = `${sessionKey}:run:retained-run`;
    const otherSessionKey = "agent:main:cron:other-job";
    await write(runSessionKey, "run-session");
    await write(otherSessionKey, "other-session");
    const writerEntered = createDeferred();
    const releaseWriter = createDeferred();
    const heldWriter = runExclusiveSqliteSessionWrite(
      scope,
      async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
      },
      "session.transcript.batch",
    );
    await writerEntered.promise;

    const removal = cron.remove(job.id);
    const unrelatedAdd = addJob(cron, "unrelated-during-session-cleanup");

    try {
      await expect(unrelatedAdd).resolves.toMatchObject({ id: "unrelated-during-session-cleanup" });
    } finally {
      releaseWriter.resolve();
      await heldWriter;
      await Promise.all([
        expect(removal).resolves.toEqual({ ok: true, removed: true }),
        unrelatedAdd,
      ]);
    }
    expect([read(sessionKey), read(runSessionKey), read(otherSessionKey)]).toMatchObject([
      undefined,
      { entry: { sessionId: "run-session" } },
      { entry: { sessionId: "other-session" } },
    ]);
  });

  it("reports failed session cleanup after removal and preserves the session for retry", async () => {
    const { cron, job, sessionKey, read } = await setup("transport-session", { enabled: false });
    gatewayTestState.callGateway.mockRejectedValueOnce(new Error("Gateway disconnected"));

    await expect(cron.remove(job.id)).rejects.toThrow("Gateway disconnected");

    expect(await cron.list({ includeDisabled: true })).toEqual([]);
    expect(read(sessionKey)?.entry.sessionId).toBe("transport-session");
  });

  it("removes a base session recreated by an already-admitted run", async ({ signal }) => {
    const { cron, job, sessionKey, read, write } = await setup("active-session");
    const marker = markCronJobActive(job.id);

    const cleanupRegistration = vi.spyOn(cronCleanup, "registerPendingCronSessionCleanup");
    onTestFinished(() => cleanupRegistration.mockRestore());
    await expect(cron.remove(job.id)).resolves.toEqual({
      ok: true,
      removed: true,
      activeRunCancellationRequested: true,
      sessionCleanup: "pending",
    });
    expect(read(sessionKey)).toMatchObject({ entry: { sessionId: "active-session" } });
    await write(sessionKey, "late-session");
    const cleanupDone = cleanupRegistration.mock.calls.find(
      ([, registeredJobId]) => registeredJobId === job.id,
    )?.[2];
    if (!cleanupDone) {
      throw new Error("Cron cleanup completion was not registered");
    }
    cleanupInFlight = cleanupDone;
    clearCronJobActive(job.id, marker);

    await racePromiseWithAbortSignal(cleanupDone, signal);
    expect(read(sessionKey)).toBeUndefined();
  });

  it("fences same-id replacement across services sharing one store", async () => {
    const { cron, job, sessionKey, createCron, read, write } = await setup("original-session");
    const replacementCron = createCron();
    const originalMarker = markCronJobActive(job.id);

    await cron.remove(job.id);
    let replacementAdded = false;
    const replacementPromise = addJob(replacementCron, job.id).then(() => {
      replacementAdded = true;
    });
    await replacementCron.status();
    expect(replacementAdded).toBe(false);

    clearCronJobActive(job.id, originalMarker);
    await replacementPromise;
    expect(read(sessionKey)).toBeUndefined();
    await write(sessionKey, "replacement-session");

    await Promise.resolve();
    await Promise.resolve();
    expect(read(sessionKey)).toMatchObject({ entry: { sessionId: "replacement-session" } });
  });

  it("does not delete a shared main session", async () => {
    const { cron, job, read, write } = await setup(undefined, {
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "work" },
    });
    const sessionKey = "agent:main:main";
    await write(sessionKey, "main-session");

    await cron.remove(job.id);

    expect(read(sessionKey)).toMatchObject({ entry: { sessionId: "main-session" } });
  });
});

import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import type { CronEvent, CronServiceDeps } from "./service.js";
import { CronService } from "./service.js";
import { createDeferred, createNoopLogger, installCronTestHooks } from "./service.test-harness.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });

type FakeFsEntry =
  | { kind: "file"; content: string; mtimeMs: number }
  | { kind: "dir"; mtimeMs: number };

const fsState = vi.hoisted(() => ({
  entries: new Map<string, FakeFsEntry>(),
  nowMs: 0,
  fixtureCount: 0,
}));

const abs = (p: string) => path.resolve(p);
const fixturesRoot = abs(path.join("__openclaw_vitest__", "cron", "runs-one-shot"));
const isFixturePath = (p: string) => {
  const resolved = abs(p);
  const rootPrefix = `${fixturesRoot}${path.sep}`;
  return resolved === fixturesRoot || resolved.startsWith(rootPrefix);
};

function bumpMtimeMs() {
  fsState.nowMs += 1;
  return fsState.nowMs;
}

function ensureDir(dirPath: string) {
  let current = abs(dirPath);
  while (true) {
    if (!fsState.entries.has(current)) {
      fsState.entries.set(current, { kind: "dir", mtimeMs: bumpMtimeMs() });
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

function setFile(filePath: string, content: string) {
  const resolved = abs(filePath);
  ensureDir(path.dirname(resolved));
  fsState.entries.set(resolved, { kind: "file", content, mtimeMs: bumpMtimeMs() });
}

async function makeStorePath() {
  const dir = path.join(fixturesRoot, `case-${fsState.fixtureCount++}`);
  ensureDir(dir);
  const storePath = path.join(dir, "cron", "jobs.json");
  ensureDir(path.dirname(storePath));
  return { storePath, cleanup: async () => {} };
}

function writeStoreFile(storePath: string, payload: unknown) {
  setFile(storePath, JSON.stringify(payload, null, 2));
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);
  const isFixtureInMock = (p: string) => {
    const resolved = absInMock(p);
    const rootPrefix = `${absInMock(fixturesRoot)}${pathMod.sep}`;
    return resolved === absInMock(fixturesRoot) || resolved.startsWith(rootPrefix);
  };

  const mkErr = (code: string, message: string) => Object.assign(new Error(message), { code });

  const promises = {
    ...actual.promises,
    mkdir: async (p: string) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.mkdir as any)(p, { recursive: true });
      }
      ensureDir(p);
    },
    readFile: async (p: string) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.readFile as any)(p, "utf-8");
      }
      const entry = fsState.entries.get(absInMock(p));
      if (!entry || entry.kind !== "file") {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, open '${p}'`);
      }
      return entry.content;
    },
    writeFile: async (p: string, data: string | Uint8Array) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.writeFile as any)(p, data, "utf-8");
      }
      const content = typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
      setFile(p, content);
    },
    rename: async (from: string, to: string) => {
      if (!isFixtureInMock(from) || !isFixtureInMock(to)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.rename as any)(from, to);
      }
      const fromAbs = absInMock(from);
      const toAbs = absInMock(to);
      const entry = fsState.entries.get(fromAbs);
      if (!entry || entry.kind !== "file") {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
      }
      ensureDir(pathMod.dirname(toAbs));
      fsState.entries.delete(fromAbs);
      fsState.entries.set(toAbs, { ...entry, mtimeMs: bumpMtimeMs() });
    },
    copyFile: async (from: string, to: string) => {
      if (!isFixtureInMock(from) || !isFixtureInMock(to)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.copyFile as any)(from, to);
      }
      const entry = fsState.entries.get(absInMock(from));
      if (!entry || entry.kind !== "file") {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, copyfile '${from}' -> '${to}'`);
      }
      setFile(to, entry.content);
    },
    stat: async (p: string) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.stat as any)(p);
      }
      const entry = fsState.entries.get(absInMock(p));
      if (!entry) {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, stat '${p}'`);
      }
      return {
        mtimeMs: entry.mtimeMs,
        isDirectory: () => entry.kind === "dir",
        isFile: () => entry.kind === "file",
      };
    },
    access: async (p: string) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.access as any)(p);
      }
      const entry = fsState.entries.get(absInMock(p));
      if (!entry) {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, access '${p}'`);
      }
    },
    unlink: async (p: string) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.unlink as any)(p);
      }
      fsState.entries.delete(absInMock(p));
    },
  } as unknown as typeof actual.promises;

  const wrapped = { ...actual, promises };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = {
    ...actual,
    mkdir: async (p: string, _opts?: unknown) => {
      if (!isFixturePath(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.mkdir as any)(p, { recursive: true });
      }
      ensureDir(p);
    },
    writeFile: async (p: string, data: string, _enc?: unknown) => {
      if (!isFixturePath(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.writeFile as any)(p, data, "utf-8");
      }
      setFile(p, data);
    },
  };
  return { ...wrapped, default: wrapped };
});

beforeEach(() => {
  fsState.entries.clear();
  fsState.nowMs = 0;
  fsState.fixtureCount = 0;
  ensureDir(fixturesRoot);
});

function createCronEventHarness() {
  const events: CronEvent[] = [];
  const waiters: Array<{
    predicate: (evt: CronEvent) => boolean;
    deferred: ReturnType<typeof createDeferred<CronEvent>>;
  }> = [];

  const onEvent = (evt: CronEvent) => {
    events.push(evt);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter && waiter.predicate(evt)) {
        waiters.splice(i, 1);
        waiter.deferred.resolve(evt);
      }
    }
  };

  const waitFor = (predicate: (evt: CronEvent) => boolean) => {
    for (const evt of events) {
      if (predicate(evt)) {
        return Promise.resolve(evt);
      }
    }
    const deferred = createDeferred<CronEvent>();
    waiters.push({ predicate, deferred });
    return deferred.promise;
  };

  return { onEvent, waitFor, events };
}

type CronHarnessOptions = {
  runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  runHeartbeatOnce?: NonNullable<CronServiceDeps["runHeartbeatOnce"]>;
  nowMs?: () => number;
  wakeNowHeartbeatBusyMaxWaitMs?: number;
  wakeNowHeartbeatBusyRetryDelayMs?: number;
  withEvents?: boolean;
};

async function createCronHarness(options: CronHarnessOptions = {}) {
  ensureDir(fixturesRoot);
  const store = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeatNow = vi.fn();
  const events = options.withEvents === false ? undefined : createCronEventHarness();

  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: noopLogger,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.wakeNowHeartbeatBusyMaxWaitMs !== undefined
      ? { wakeNowHeartbeatBusyMaxWaitMs: options.wakeNowHeartbeatBusyMaxWaitMs }
      : {}),
    ...(options.wakeNowHeartbeatBusyRetryDelayMs !== undefined
      ? { wakeNowHeartbeatBusyRetryDelayMs: options.wakeNowHeartbeatBusyRetryDelayMs }
      : {}),
    enqueueSystemEvent,
    requestHeartbeatNow,
    ...(options.runHeartbeatOnce ? { runHeartbeatOnce: options.runHeartbeatOnce } : {}),
    runIsolatedAgentJob:
      options.runIsolatedAgentJob ??
      (vi.fn(async (_params: { job: unknown; message: string }) => ({
        status: "ok",
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"]),
    ...(events ? { onEvent: events.onEvent } : {}),
  });
  await cron.start();
  return { store, cron, enqueueSystemEvent, requestHeartbeatNow, events };
}

async function createMainOneShotHarness() {
  const harness = await createCronHarness();
  if (!harness.events) {
    throw new Error("missing event harness");
  }
  return { ...harness, events: harness.events };
}

async function createIsolatedAnnounceHarness(
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"],
) {
  const harness = await createCronHarness({
    runIsolatedAgentJob,
  });
  if (!harness.events) {
    throw new Error("missing event harness");
  }
  return { ...harness, events: harness.events };
}

async function createWakeModeNowMainHarness(options: {
  nowMs?: () => number;
  runHeartbeatOnce: NonNullable<CronServiceDeps["runHeartbeatOnce"]>;
  wakeNowHeartbeatBusyMaxWaitMs?: number;
  wakeNowHeartbeatBusyRetryDelayMs?: number;
}) {
  return createCronHarness({
    runHeartbeatOnce: options.runHeartbeatOnce,
    nowMs: options.nowMs,
    wakeNowHeartbeatBusyMaxWaitMs: options.wakeNowHeartbeatBusyMaxWaitMs,
    wakeNowHeartbeatBusyRetryDelayMs: options.wakeNowHeartbeatBusyRetryDelayMs,
    withEvents: false,
  });
}

async function addDefaultIsolatedAnnounceJob(cron: CronService, name: string) {
  const runAt = new Date("2025-12-13T00:00:01.000Z");
  const job = await cron.add({
    enabled: true,
    name,
    schedule: { kind: "at", at: runAt.toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "do it" },
    delivery: { mode: "announce" },
  });
  return { job, runAt };
}

async function runIsolatedAnnounceJobAndWait(params: {
  cron: CronService;
  events: ReturnType<typeof createCronEventHarness>;
  name: string;
  status: "ok" | "error";
}) {
  const { job, runAt } = await addDefaultIsolatedAnnounceJob(params.cron, params.name);
  vi.setSystemTime(runAt);
  await vi.runOnlyPendingTimersAsync();
  await params.events.waitFor(
    (evt) => evt.jobId === job.id && evt.action === "finished" && evt.status === params.status,
  );
  return job;
}

async function addWakeModeNowMainSystemEventJob(
  cron: CronService,
  options?: { name?: string; agentId?: string; sessionKey?: string },
) {
  return cron.add({
    name: options?.name ?? "wakeMode now",
    ...(options?.agentId ? { agentId: options.agentId } : {}),
    ...(options?.sessionKey ? { sessionKey: options.sessionKey } : {}),
    enabled: true,
    schedule: { kind: "at", at: new Date(1).toISOString() },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "hello" },
  });
}

function createLegacyDeliveryMigrationJob(options: {
  id: string;
  payload: { provider?: string; channel?: string };
}) {
  return {
    id: options.id,
    name: "legacy",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "cron", expr: "* * * * *" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "hi",
      deliver: true,
      ...options.payload,
      to: "7200373102",
    },
    state: {},
  };
}

async function loadLegacyDeliveryMigration(rawJob: Record<string, unknown>) {
  ensureDir(fixturesRoot);
  const store = await makeStorePath();
  writeStoreFile(store.storePath, { version: 1, jobs: [rawJob] });

  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await cron.start();
  const jobs = await cron.list({ includeDisabled: true });
  const job = jobs.find((j) => j.id === rawJob.id);
  return { store, cron, job };
}

describe("CronService", () => {
  it("runs a one-shot main job and disables it after success when requested", async () => {
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events } =
      await createMainOneShotHarness();
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");
    const job = await cron.add({
      name: "one-shot hello",
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    expect(job.state.nextRunAtMs).toBe(atMs);

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "finished");

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.enabled).toBe(false);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(requestHeartbeatNow).toHaveBeenCalled();

    await cron.list({ includeDisabled: true });
    cron.stop();
    await store.cleanup();
  });

  it("runs a one-shot job and deletes it after success by default", async () => {
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events } =
      await createMainOneShotHarness();
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");
    const job = await cron.add({
      name: "one-shot delete",
      enabled: true,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "removed");

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(requestHeartbeatNow).toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("wakeMode now waits for heartbeat completion when available", async () => {
    let now = 0;
    const nowMs = () => {
      now += 10;
      return now;
    };

    let resolveHeartbeat: ((res: HeartbeatRunResult) => void) | null = null;
    const runHeartbeatOnce = vi.fn(
      async () =>
        await new Promise<HeartbeatRunResult>((resolve) => {
          resolveHeartbeat = resolve;
        }),
    );

    const { store, cron, enqueueSystemEvent, requestHeartbeatNow } =
      await createWakeModeNowMainHarness({
        runHeartbeatOnce,
        nowMs,
      });
    const job = await addWakeModeNowMainSystemEventJob(cron, { name: "wakeMode now waits" });

    const runPromise = cron.run(job.id, "force");
    // `cron.run()` now persists the running marker before executing the job.
    // Allow more microtask turns so the post-lock execution can start.
    for (let i = 0; i < 500; i++) {
      if (runHeartbeatOnce.mock.calls.length > 0) {
        break;
      }
      // Let the locked() chain progress.
      await Promise.resolve();
    }

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(job.state.runningAtMs).toBeTypeOf("number");

    if (typeof resolveHeartbeat === "function") {
      (resolveHeartbeat as (res: HeartbeatRunResult) => void)({ status: "ran", durationMs: 123 });
    }
    await runPromise;

    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastDurationMs).toBeGreaterThan(0);

    cron.stop();
    await store.cleanup();
  });

  it("passes agentId + sessionKey to runHeartbeatOnce for main-session wakeMode now jobs", async () => {
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));

    const { store, cron, enqueueSystemEvent, requestHeartbeatNow } =
      await createWakeModeNowMainHarness({
        runHeartbeatOnce,
        // Perf: avoid advancing fake timers by 2+ minutes for the busy-heartbeat fallback.
        wakeNowHeartbeatBusyMaxWaitMs: 1,
        wakeNowHeartbeatBusyRetryDelayMs: 2,
      });

    const sessionKey = "agent:ops:discord:channel:alerts";
    const job = await addWakeModeNowMainSystemEventJob(cron, {
      name: "wakeMode now with agent",
      agentId: "ops",
      sessionKey,
    });

    await cron.run(job.id, "force");

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(runHeartbeatOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: `cron:${job.id}`,
        agentId: "ops",
        sessionKey,
      }),
    );
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ agentId: "ops", sessionKey }),
    );

    cron.stop();
    await store.cleanup();
  });

  it("wakeMode now falls back to queued heartbeat when main lane stays busy", async () => {
    const runHeartbeatOnce = vi.fn(async () => ({
      status: "skipped" as const,
      reason: "requests-in-flight",
    }));
    let now = 0;
    const nowMs = () => {
      now += 10;
      return now;
    };

    const { store, cron, requestHeartbeatNow } = await createWakeModeNowMainHarness({
      runHeartbeatOnce,
      nowMs,
      // Perf: avoid advancing fake timers by 2+ minutes for the busy-heartbeat fallback.
      wakeNowHeartbeatBusyMaxWaitMs: 1,
      wakeNowHeartbeatBusyRetryDelayMs: 2,
    });

    const sessionKey = "agent:main:discord:channel:ops";
    const job = await addWakeModeNowMainSystemEventJob(cron, {
      name: "wakeMode now fallback",
      sessionKey,
    });

    await cron.run(job.id, "force");

    expect(runHeartbeatOnce).toHaveBeenCalled();
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: `cron:${job.id}`,
        sessionKey,
      }),
    );
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastError).toBeUndefined();

    await cron.list({ includeDisabled: true });
    cron.stop();
    await store.cleanup();
  });

  it("runs an isolated job and posts summary to main", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({ cron, events, name: "weekly", status: "ok" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Cron: done",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(requestHeartbeatNow).toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("does not post isolated summary to main when run already delivered output", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: true,
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "weekly delivered",
      status: "ok",
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("migrates legacy payload.provider to payload.channel on load", async () => {
    const rawJob = createLegacyDeliveryMigrationJob({
      id: "legacy-1",
      payload: { provider: " TeLeGrAm " },
    });
    const { store, cron, job } = await loadLegacyDeliveryMigration(rawJob);
    // Legacy delivery fields are migrated to the top-level delivery object
    const delivery = job?.delivery as unknown as Record<string, unknown>;
    expect(delivery?.channel).toBe("telegram");
    const payload = job?.payload as unknown as Record<string, unknown>;
    expect("provider" in payload).toBe(false);
    expect("channel" in payload).toBe(false);

    cron.stop();
    await store.cleanup();
  });

  it("canonicalizes payload.channel casing on load", async () => {
    const rawJob = createLegacyDeliveryMigrationJob({
      id: "legacy-2",
      payload: { channel: "Telegram" },
    });
    const { store, cron, job } = await loadLegacyDeliveryMigration(rawJob);
    // Legacy delivery fields are migrated to the top-level delivery object
    const delivery = job?.delivery as unknown as Record<string, unknown>;
    expect(delivery?.channel).toBe("telegram");

    cron.stop();
    await store.cleanup();
  });

  it("posts last output to main even when isolated job errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "boom",
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated error test",
      status: "error",
    });

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Cron (error): last output",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(requestHeartbeatNow).toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("does not post fallback main summary for isolated delivery-target errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "Channel is required when multiple channels are configured: telegram, discord",
      errorKind: "delivery-target" as const,
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated delivery target error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("rejects unsupported session/payload combinations", async () => {
    ensureDir(fixturesRoot);
    const store = await makeStorePath();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async (_params: { job: unknown; message: string }) => ({
        status: "ok",
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"],
    });

    await cron.start();

    await expect(
      cron.add({
        name: "bad combo (main/agentTurn)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "nope" },
      }),
    ).rejects.toThrow(/main cron jobs require/);

    await expect(
      cron.add({
        name: "bad combo (isolated/systemEvent)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "nope" },
      }),
    ).rejects.toThrow(/isolated cron jobs require/);

    cron.stop();
    await store.cleanup();
  });

  it("skips invalid main jobs with agentTurn payloads from disk", async () => {
    ensureDir(fixturesRoot);
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const events = createCronEventHarness();

    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    writeStoreFile(store.storePath, {
      version: 1,
      jobs: [
        {
          id: "job-1",
          enabled: true,
          createdAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
          schedule: { kind: "at", at: new Date(atMs).toISOString() },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "bad" },
          state: {},
        },
      ],
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async (_params: { job: unknown; message: string }) => ({
        status: "ok",
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"],
      onEvent: events.onEvent,
    });

    await cron.start();

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor(
      (evt) => evt.jobId === "job-1" && evt.action === "finished" && evt.status === "skipped",
    );

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/main job requires/i);

    cron.stop();
    await store.cleanup();
  });
});

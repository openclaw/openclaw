import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import type { CronEvent, CronServiceDeps } from "./service.js";
import { CronService } from "./service.js";
import { createCronServiceState, type CronServiceState } from "./service/state.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

type NoopLogger = {
  debug: MockFn;
  info: MockFn;
  warn: MockFn;
  error: MockFn;
};

export function createNoopLogger(): NoopLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export function createCronStoreHarness(options?: { prefix?: string }) {
  let fixtureRoot = "";
  let caseId = 0;
  let originalOpenClawStateDir: string | undefined;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), options?.prefix ?? "openclaw-cron-"));
    originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(fixtureRoot, "state");
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    if (originalOpenClawStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
    }
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function makeStorePath() {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(dir, { recursive: true });
    return {
      storePath: path.join(dir, "cron", "jobs.json"),
      cleanup: async () => {},
    };
  }

  async function makeStoreKey() {
    const id = `case-${caseId++}`;
    const stateDir = path.join(fixtureRoot, id, "state");
    await fs.mkdir(stateDir, { recursive: true });
    return {
      storeKey: id,
      stateDir,
      cleanup: async () => {},
    };
  }

  return { makeStorePath, makeStoreKey };
}

export async function writeCronStoreSnapshot(params: {
  storeKey?: string;
  storePath?: string;
  jobs: CronJob[];
}) {
  await saveCronStore(params.storeKey ?? params.storePath ?? "default", {
    version: 1,
    jobs: params.jobs,
  });
}

export function installCronTestHooks(options: {
  logger: ReturnType<typeof createNoopLogger>;
  baseTimeIso?: string;
}) {
  beforeEach(() => {
    vi.useFakeTimers();
    // Shared unit-thread workers run with isolate disabled, so leaked cron
    // timers from a previous file can still sit in the fake-timer queue.
    // Clear them before advancing time in the next test file.
    vi.clearAllTimers();
    vi.setSystemTime(new Date(options.baseTimeIso ?? "2025-12-13T00:00:00.000Z"));
    options.logger.debug.mockClear();
    options.logger.info.mockClear();
    options.logger.warn.mockClear();
    options.logger.error.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
}

export function setupCronServiceSuite(options?: { prefix?: string; baseTimeIso?: string }) {
  const logger = createNoopLogger();
  const { makeStorePath, makeStoreKey } = createCronStoreHarness({ prefix: options?.prefix });
  installCronTestHooks({
    logger,
    baseTimeIso: options?.baseTimeIso,
  });
  return { logger, makeStorePath, makeStoreKey };
}

export function createFinishedBarrier() {
  const resolvers = new Map<string, (evt: CronEvent) => void>();
  return {
    waitForOk: (jobId: string) =>
      new Promise<CronEvent>((resolve) => {
        resolvers.set(jobId, resolve);
      }),
    onEvent: (evt: CronEvent) => {
      if (evt.action !== "finished" || evt.status !== "ok") {
        return;
      }
      const resolve = resolvers.get(evt.jobId);
      if (!resolve) {
        return;
      }
      resolvers.delete(evt.jobId);
      resolve(evt);
    },
  };
}

export function createStartedCronServiceWithFinishedBarrier(params: {
  storeKey?: string;
  storePath?: string;
  logger: ReturnType<typeof createNoopLogger>;
}): {
  cron: CronService;
  enqueueSystemEvent: MockFn;
  requestHeartbeat: MockFn;
  finished: ReturnType<typeof createFinishedBarrier>;
} {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const finished = createFinishedBarrier();
  const cron = new CronService({
    storeKey: params.storeKey ?? params.storePath ?? "default",
    cronEnabled: true,
    log: params.logger,
    enqueueSystemEvent,
    requestHeartbeat,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent: finished.onEvent,
  });
  return { cron, enqueueSystemEvent, requestHeartbeat, finished };
}

export async function withCronServiceForTest(
  params: {
    makeStoreKey?: () => Promise<{ storeKey: string; cleanup?: () => Promise<void> }>;
    makeStorePath?: () => Promise<{ storePath: string; cleanup: () => Promise<void> }>;
    logger: ReturnType<typeof createNoopLogger>;
    cronEnabled: boolean;
    runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  },
  run: (context: {
    cron: CronService;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeat: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
): Promise<void> {
  const store = params.makeStoreKey ? await params.makeStoreKey() : await params.makeStorePath?.();
  if (!store) {
    throw new Error("withCronServiceForTest requires a cron store key or legacy store path");
  }
  const storeKey = "storeKey" in store ? store.storeKey : store.storePath;
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const cron = new CronService({
    cronEnabled: params.cronEnabled,
    storeKey,
    log: params.logger,
    enqueueSystemEvent,
    requestHeartbeat,
    runIsolatedAgentJob:
      params.runIsolatedAgentJob ??
      (vi.fn(async () => ({ status: "ok" as const, summary: "done" })) as never),
  });

  await cron.start();
  try {
    await run({ cron, enqueueSystemEvent, requestHeartbeat });
  } finally {
    cron.stop();
    await store.cleanup?.();
  }
}

export function createRunningCronServiceState(params: {
  storeKey?: string;
  storePath?: string;
  log: ReturnType<typeof createNoopLogger>;
  nowMs: () => number;
  jobs: CronJob[];
}) {
  const state = createCronServiceState({
    cronEnabled: true,
    storeKey: params.storeKey ?? params.storePath ?? "default",
    log: params.log,
    nowMs: params.nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
  });
  state.running = true;
  state.store = {
    version: 1,
    jobs: params.jobs,
  };
  return state;
}

function disposeCronServiceState(state: { timer: NodeJS.Timeout | null }): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export async function withCronServiceStateForTest<T>(
  state: { timer: NodeJS.Timeout | null },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    disposeCronServiceState(state);
  }
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createMockCronStateForJobs(params: {
  jobs: CronJob[];
  nowMs?: number;
}): CronServiceState {
  const nowMs = params.nowMs ?? Date.now();
  return {
    store: { version: 1, jobs: params.jobs },
    running: false,
    timer: null,
    storeLoadedAtMs: nowMs,
    op: Promise.resolve(),
    warnedDisabled: false,
    warnedMissingSessionTargetJobIds: new Set<string>(),
    deps: {
      storeKey: "mock",
      cronEnabled: true,
      nowMs: () => nowMs,
      enqueueSystemEvent: () => {},
      requestHeartbeat: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as never,
    },
  };
}

// Cron service test harness builds isolated stores, timers, and delivery fixtures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import type { CronEvent } from "./service.js";
import { CronService } from "./service.js";
import { stop } from "./service/ops-lifecycle.js";
import * as cronServiceState from "./service/state.js";
import {
  createCronServiceState,
  type CronServiceState,
  type CronServiceDeps,
} from "./service/state.js";
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

/** Capture the facade's actual state while keeping construction and runtime behavior intact. */
export function createCronServiceWithStateForTest(deps: CronServiceDeps): {
  cron: CronService;
  state: CronServiceState;
} {
  let state: CronServiceState | undefined;
  const createState = cronServiceState.createCronServiceState;
  const capture = vi.spyOn(cronServiceState, "createCronServiceState");
  capture.mockImplementationOnce((serviceDeps) => {
    state = createState(serviceDeps);
    return state;
  });
  try {
    const cron = new CronService(deps);
    if (!state) {
      throw new Error("Cron service construction did not publish its state");
    }
    return { cron, state };
  } finally {
    capture.mockRestore();
  }
}

export function createCronStoreHarness(options?: { prefix?: string }) {
  let fixtureRoot = "";
  let caseId = 0;
  const stores = new Map<string, string>();

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), options?.prefix ?? "openclaw-cron-"));
    fixtureRoot = await fs.realpath(fixtureRoot);
  });

  async function cleanupStore(storePath: string, dir: string) {
    if (!stores.has(storePath)) {
      return;
    }
    await saveCronStore(storePath, { version: 1, jobs: [] });
    await closeOpenClawAgentDatabasesAsync(dir);
    await fs.rm(dir, { recursive: true, force: true });
    stores.delete(storePath);
  }

  afterEach(async () => {
    for (const [storePath, dir] of stores) {
      await cleanupStore(storePath, dir);
    }
  });

  afterAll(async () => {
    for (const [storePath, dir] of stores) {
      await cleanupStore(storePath, dir);
    }
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function makeStorePath() {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(dir, { recursive: true });
    const storePath = path.join(dir, "cron", "jobs.json");
    stores.set(storePath, dir);
    return {
      storePath,
      cleanup: async () => await cleanupStore(storePath, dir),
    };
  }

  return { makeStorePath };
}

export async function writeCronStoreSnapshot(params: { storePath: string; jobs: CronJob[] }) {
  await saveCronStore(params.storePath, {
    version: 1,
    jobs: params.jobs,
  });
}

export function installCronTestHooks(options: {
  logger: ReturnType<typeof createNoopLogger>;
  baseTimeIso?: string;
  fakeTimers?: boolean;
}) {
  beforeEach(() => {
    if (options.fakeTimers !== false) {
      vi.useFakeTimers();
      // Shared unit-thread workers run with isolate disabled, so leaked cron
      // timers from a previous file can still sit in the fake-timer queue.
      // Clear them before advancing time in the next test file.
      vi.clearAllTimers();
      vi.setSystemTime(new Date(options.baseTimeIso ?? "2025-12-13T00:00:00.000Z"));
    }
    options.logger.debug.mockClear();
    options.logger.info.mockClear();
    options.logger.warn.mockClear();
    options.logger.error.mockClear();
  });

  afterEach(() => {
    if (options.fakeTimers !== false) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
}

export function setupCronServiceSuite(options?: {
  prefix?: string;
  baseTimeIso?: string;
  fakeTimers?: boolean;
}) {
  const logger = createNoopLogger();
  const { makeStorePath } = createCronStoreHarness({ prefix: options?.prefix });
  installCronTestHooks({
    logger,
    baseTimeIso: options?.baseTimeIso,
    fakeTimers: options?.fakeTimers,
  });
  return { logger, makeStorePath };
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
  scheduler: CronServiceDeps["scheduler"];
  nowMs?: CronServiceDeps["nowMs"];
  storePath: string;
  logger: ReturnType<typeof createNoopLogger>;
  runSessionEvent?: CronServiceDeps["runSessionEvent"];
  onEvent?: CronServiceDeps["onEvent"];
}): {
  cron: CronService;
  state: CronServiceState;
  enqueueSystemEvent: MockFn;
  enqueueSessionEvent: ReturnType<
    typeof vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>
  >;
  runSessionEvent: ReturnType<typeof vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>>;
  finished: ReturnType<typeof createFinishedBarrier>;
} {
  const enqueueSystemEvent = vi.fn();
  const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
  const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(
    params.runSessionEvent ?? (async () => ({ status: "ok" })),
  );
  const finished = createFinishedBarrier();
  const { cron, state } = createCronServiceWithStateForTest({
    scheduler: params.scheduler,
    nowMs: params.nowMs,
    storePath: params.storePath,
    cronEnabled: true,
    log: params.logger,
    enqueueSystemEvent,
    enqueueSessionEvent,
    runSessionEvent,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent: (event) => {
      finished.onEvent(event);
      params.onEvent?.(event);
    },
  });
  return {
    cron,
    state,
    enqueueSystemEvent,
    enqueueSessionEvent,
    runSessionEvent,
    finished,
  };
}

export async function withCronServiceForTest(
  params: {
    scheduler: CronServiceDeps["scheduler"];
    nowMs?: CronServiceDeps["nowMs"];
    makeStorePath: () => Promise<{ storePath: string; cleanup: () => Promise<void> }>;
    logger: ReturnType<typeof createNoopLogger>;
    cronEnabled: boolean;
    runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
    runSessionEvent?: CronServiceDeps["runSessionEvent"];
  },
  run: (context: {
    cron: CronService;
    state: CronServiceState;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    enqueueSessionEvent: ReturnType<
      typeof vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>
    >;
    runSessionEvent: ReturnType<typeof vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>>;
  }) => Promise<void>,
): Promise<void> {
  const store = await params.makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
  const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(
    params.runSessionEvent ?? (async () => ({ status: "ok" })),
  );
  const { cron, state } = createCronServiceWithStateForTest({
    scheduler: params.scheduler,
    nowMs: params.nowMs,
    cronEnabled: params.cronEnabled,
    storePath: store.storePath,
    log: params.logger,
    enqueueSystemEvent,
    enqueueSessionEvent,
    runSessionEvent,
    runIsolatedAgentJob:
      params.runIsolatedAgentJob ??
      (vi.fn(async () => ({ status: "ok" as const, summary: "done" })) as never),
  });

  await cron.start();
  try {
    await run({
      cron,
      state,
      enqueueSystemEvent,
      enqueueSessionEvent,
      runSessionEvent,
    });
  } finally {
    cron.stop();
    await store.cleanup();
  }
}

export async function withCronServiceStateForTest<T>(
  state: CronServiceState,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    stop(state);
    await state.schedulerDrain;
  }
}

export function createMockCronStateForJobs(params: {
  jobs: CronJob[];
  nowMs?: number;
}): CronServiceState {
  const nowMs = params.nowMs ?? Date.now();
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: "/mock/path",
    cronEnabled: true,
    defaultAgentId: "main",
    nowMs: () => nowMs,
    enqueueSystemEvent: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
    log: createNoopLogger(),
  });
  state.store = { version: 1, jobs: params.jobs };
  state.storeLoadedAtMs = nowMs;
  return state;
}

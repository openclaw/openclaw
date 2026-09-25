// Cron service test harness builds isolated stores, timers, and delivery fixtures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import type { CronEvent } from "./service.js";
import { CronService } from "./service.js";
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

type CronHarnessHooks = Record<
  "beforeAll" | "beforeEach" | "afterEach" | "afterAll",
  (callback: () => void | Promise<void>) => unknown
>;

const cronHarnessHooks: CronHarnessHooks = { beforeAll, beforeEach, afterEach, afterAll };

export function createCronStoreHarness(options?: {
  prefix?: string;
  root?: string;
  hooks?: CronHarnessHooks;
}) {
  let fixtureRoot = "";
  let owner: ReturnType<typeof createVitestResourceOwner> | undefined;
  let closing = false;
  let caseId = 0;
  const stores = new Map<string, string>();
  const hooks = options?.hooks ?? cronHarnessHooks;

  hooks.beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(
      path.join(options?.root ?? os.tmpdir(), options?.prefix ?? "openclaw-cron-"),
    );
    owner = createVitestResourceOwner(fixtureRoot);
  });

  function assertReleased() {
    if (!owner) {
      throw new Error("Cron fixture resource owner is unavailable");
    }
    owner.assertReleased();
    return owner;
  }

  function assertAdmission() {
    const current = assertReleased();
    if (closing) {
      throw new Error("Cron fixture acquisition is closed");
    }
    return current;
  }

  async function cleanupStore(storePath: string, dir: string) {
    assertReleased();
    if (!stores.has(storePath)) {
      return;
    }
    await saveCronStore(storePath, { version: 1, jobs: [] });
    await fs.rm(dir, { recursive: true, force: true });
    stores.delete(storePath);
  }

  hooks.afterEach(async () => {
    assertReleased();
    for (const [storePath, dir] of stores) {
      await cleanupStore(storePath, dir);
    }
  });

  hooks.afterAll(async () => {
    closing = true;
    if (!fixtureRoot) {
      return;
    }
    assertReleased();
    for (const [storePath, dir] of stores) {
      await cleanupStore(storePath, dir);
    }
    assertReleased();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function allocateStore(assertOpen: () => void) {
    assertOpen();
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    const storePath = path.join(dir, "cron", "jobs.json");
    // A late mkdir still belongs to this case, even when teardown closes admission.
    stores.set(storePath, dir);
    await fs.mkdir(dir, { recursive: true });
    assertOpen();
    return {
      storePath,
      cleanup: async () => await cleanupStore(storePath, dir),
    };
  }

  return {
    makeStorePath: () => allocateStore(assertAdmission),
    assertReleased,
    acquireFixture() {
      const release = assertAdmission().claim();
      let retired = false;
      let verified: Promise<void> | undefined;
      const closeAdmission = () => {
        retired = true;
      };
      return {
        closeAdmission,
        makeStorePath: () =>
          allocateStore(() => {
            if (retired || closing) {
              throw new Error("Cron fixture acquisition is closed");
            }
          }),
        verifyQuiescence(body: () => Promise<void>) {
          closeAdmission();
          // A failed drain permanently retains its receipt; retry cannot certify it.
          return (verified ??= Promise.resolve().then(body).then(release));
        },
      };
    },
  };
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
  assertReleased?: () => void;
  hooks?: CronHarnessHooks;
}) {
  const hooks = options.hooks ?? cronHarnessHooks;
  hooks.beforeEach(() => {
    options.assertReleased?.();
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

  hooks.afterEach(() => {
    options.assertReleased?.();
    vi.clearAllTimers();
    vi.useRealTimers();
  });
}

export function setupCronServiceSuite(options?: {
  prefix?: string;
  baseTimeIso?: string;
  root?: string;
  hooks?: CronHarnessHooks;
}) {
  const logger = createNoopLogger();
  const stores = createCronStoreHarness(options);
  installCronTestHooks({
    logger,
    baseTimeIso: options?.baseTimeIso,
    assertReleased: stores.assertReleased,
    hooks: options?.hooks,
  });
  return { logger, ...stores };
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
  storePath: string;
  logger: ReturnType<typeof createNoopLogger>;
  requestHeartbeatAndWait?: CronServiceDeps["requestHeartbeatAndWait"];
  resolveHeartbeatTimeoutMs?: CronServiceDeps["resolveHeartbeatTimeoutMs"];
  onEvent?: CronServiceDeps["onEvent"];
}): {
  cron: CronService;
  enqueueSystemEvent: MockFn;
  requestHeartbeat: MockFn;
  requestHeartbeatAndWait: MockFn;
  finished: ReturnType<typeof createFinishedBarrier>;
} {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const requestHeartbeatAndWait = vi.fn(
    params.requestHeartbeatAndWait ?? (async () => ({ status: "ran" as const, durationMs: 1 })),
  );
  const finished = createFinishedBarrier();
  const cron = new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: params.logger,
    enqueueSystemEvent,
    requestHeartbeat,
    requestHeartbeatAndWait,
    resolveHeartbeatTimeoutMs: params.resolveHeartbeatTimeoutMs,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent: (event) => {
      finished.onEvent(event);
      params.onEvent?.(event);
    },
  });
  return { cron, enqueueSystemEvent, requestHeartbeat, requestHeartbeatAndWait, finished };
}

export async function withCronServiceForTest(
  params: {
    makeStorePath: () => Promise<{ storePath: string; cleanup: () => Promise<void> }>;
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
  const store = await params.makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const cron = new CronService({
    cronEnabled: params.cronEnabled,
    storePath: store.storePath,
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
    await store.cleanup();
  }
}

export function createRunningCronServiceState(params: {
  storePath: string;
  log: CronServiceDeps["log"];
  nowMs: () => number;
  jobs: CronJob[];
}) {
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: params.storePath,
    log: params.log,
    nowMs: params.nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
  });
  state.running = true;
  state.activeTimerTicks = 1;
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

export function createMockCronStateForJobs(params: {
  jobs: CronJob[];
  nowMs?: number;
}): CronServiceState {
  const nowMs = params.nowMs ?? Date.now();
  const state = createCronServiceState({
    storePath: "/mock/path",
    cronEnabled: true,
    defaultAgentId: "main",
    nowMs: () => nowMs,
    enqueueSystemEvent: () => {},
    requestHeartbeat: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
    log: createNoopLogger(),
  });
  state.store = { version: 1, jobs: params.jobs };
  state.storeLoadedAtMs = nowMs;
  return state;
}

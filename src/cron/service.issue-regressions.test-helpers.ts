import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { clearAllBootstrapSnapshots } from "../agents/bootstrap-cache.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import { useFrozenTime, useRealTime } from "../test-utils/frozen-time.js";
import type { CronService } from "./service.js";
import type { CronJob, CronJobState } from "./types.js";

const TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1_000;

export const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
};

let fixtureRoot = "";
let fixtureCount = 0;

export type CronServiceOptions = ConstructorParameters<typeof CronService>[0];

export function setupCronIssueRegressionFixtures() {
  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cron-issues-"));
  });

  beforeEach(() => {
    useFrozenTime("2026-02-06T10:05:00.000Z");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    useRealTime();
    clearSessionStoreCacheForTest();
    resetAgentRunContextForTest();
    clearAllBootstrapSnapshots();
    vi.resetModules();
  });
  afterAll(async () => {
    useRealTime();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  return {
    makeStorePath,
  };
}

export function topOfHourOffsetMs(jobId: string) {
  const digest = crypto.createHash("sha256").update(jobId).digest();
  return digest.readUInt32BE(0) % TOP_OF_HOUR_STAGGER_MS;
}

export function makeStorePath() {
  const storePath = path.join(fixtureRoot, `case-${fixtureCount++}.jobs.json`);
  return {
    storePath,
  };
}

export function createDueIsolatedJob(params: {
  id: string;
  nowMs: number;
  nextRunAtMs: number;
  deleteAfterRun?: boolean;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    deleteAfterRun: params.deleteAfterRun ?? false,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "at", at: new Date(params.nextRunAtMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: params.id },
    delivery: { mode: "none" },
    state: { nextRunAtMs: params.nextRunAtMs },
  };
}

export function createDefaultIsolatedRunner(): CronServiceOptions["runIsolatedAgentJob"] {
  return vi.fn().mockResolvedValue({
    status: "ok",
    summary: "ok",
  }) as CronServiceOptions["runIsolatedAgentJob"];
}

export function createAbortAwareIsolatedRunner(summary = "late") {
  let observedAbortSignal: AbortSignal | undefined;
  const runIsolatedAgentJob = vi.fn(async ({ abortSignal }) => {
    observedAbortSignal = abortSignal;
    await new Promise<void>((resolve) => {
      if (!abortSignal) {
        return;
      }
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { status: "ok" as const, summary };
  }) as CronServiceOptions["runIsolatedAgentJob"];

  return {
    runIsolatedAgentJob,
    getObservedAbortSignal: () => observedAbortSignal,
  };
}

export function createIsolatedRegressionJob(params: {
  id: string;
  name: string;
  scheduledAt: number;
  schedule: CronJob["schedule"];
  payload: CronJob["payload"];
  state?: CronJobState;
}): CronJob {
  return {
    id: params.id,
    name: params.name,
    enabled: true,
    createdAtMs: params.scheduledAt - 86_400_000,
    updatedAtMs: params.scheduledAt - 86_400_000,
    schedule: params.schedule,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: params.payload,
    delivery: { mode: "announce" },
    state: params.state ?? {},
  };
}

export async function writeCronJobs(storePath: string, jobs: CronJob[]) {
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }), "utf-8");
}

export async function writeCronStoreSnapshot(storePath: string, jobs: unknown[]) {
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }), "utf-8");
}

export async function startCronForStore(params: {
  storePath: string;
  cronEnabled?: boolean;
  enqueueSystemEvent?: CronServiceOptions["enqueueSystemEvent"];
  requestHeartbeatNow?: CronServiceOptions["requestHeartbeatNow"];
  runIsolatedAgentJob?: CronServiceOptions["runIsolatedAgentJob"];
  onEvent?: CronServiceOptions["onEvent"];
}) {
  const enqueueSystemEvent =
    params.enqueueSystemEvent ?? (vi.fn() as unknown as CronServiceOptions["enqueueSystemEvent"]);
  const requestHeartbeatNow =
    params.requestHeartbeatNow ?? (vi.fn() as unknown as CronServiceOptions["requestHeartbeatNow"]);
  const runIsolatedAgentJob = params.runIsolatedAgentJob ?? createDefaultIsolatedRunner();

  const { CronService } = await import("./service.js");
  const cron = new CronService({
    cronEnabled: params.cronEnabled ?? true,
    storePath: params.storePath,
    log: noopLogger,
    enqueueSystemEvent,
    requestHeartbeatNow,
    runIsolatedAgentJob,
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
  await cron.start();
  return cron;
}

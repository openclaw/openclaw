import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { currentPluginCommandHostProcessId } from "../plugin-command-schedule.js";
import { pluginCommandSchedule } from "../plugin-command-schedule.test-support.js";
import {
  PLUGIN_COMMAND_SCHEDULE_MESSAGE,
  type PluginCommandScheduleHost,
} from "../plugin-command-schedule.types.js";
import type { CronJobCreate } from "../types.js";
import { queueStore, requestFor } from "./run-queue.test-support.js";

const now = 1_800_000_000_000;
const previous = "1:previous-boot";
let fixture: OpenClawTestState;
let context: OpenClawStateWorkerContext;

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "plugin-command-rollback" });
  context = captureOpenClawStateWorkerContext();
  await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
});
afterAll(async () => {
  await fixture?.cleanup();
});

// Frozen copy of the envelope contract released with command schedules (#180282). It is strict:
// any envelope change would make that reader quarantine the row instead of ignoring continuity.
const nonEmpty = z.string().min(1).max(4096);
const releasedEnvelope = z.strictObject({
  version: z.literal(1),
  pluginId: nonEmpty,
  pluginIncarnation: nonEmpty,
  hostProcessId: nonEmpty,
  pluginSource: nonEmpty,
  pluginRoot: nonEmpty.optional(),
  pluginVersion: nonEmpty.optional(),
  command: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  args: nonEmpty.optional(),
  channel: nonEmpty,
  parent: z.strictObject({
    agentId: nonEmpty,
    sessionKey: nonEmpty,
    sessionId: nonEmpty,
    lifecycleRevision: nonEmpty.optional(),
  }),
  sourceRunId: nonEmpty,
  operatorSource: z.unknown(),
  toolsAllow: z.array(z.string()).min(2),
  deadlineAtMs: z.number().int(),
  maxRuns: z.number().int().min(1).max(100),
});

type Row = { enabled: number; payload_kind: string; job_json: string; state_json: string };

async function withStateDatabase<T>(
  read: (db: ReturnType<typeof openOpenClawStateDatabase>["db"]) => T,
) {
  await closeOpenClawStateDatabaseAsync();
  try {
    return read(openOpenClawStateDatabase().db);
  } finally {
    await closeOpenClawStateDatabaseAsync();
    context = captureOpenClawStateWorkerContext();
  }
}

/**
 * The released reader's occurrence claim for a command schedule, applied to the stored row: it
 * selects `pluginCommand` rows, decodes the strict envelope, keeps job state as an opaque record,
 * and retires a schedule whose envelope names another Gateway process, writing that state back.
 */
async function claimWithReleasedReader(storeKey: string, jobId: string, occurrence: boolean) {
  const hostProcessId = "2:released-boot";
  return await withStateDatabase((db) => {
    const row = db
      .prepare(
        "SELECT enabled, payload_kind, job_json, state_json FROM cron_jobs WHERE store_key = ? AND job_id = ?",
      )
      .get(storeKey, jobId) as Row | undefined;
    if (!row || row.payload_kind !== "pluginCommand") {
      throw new Error("released reader did not select the command schedule");
    }
    const definition = JSON.parse(row.job_json) as { pluginCommand: unknown };
    const envelope = releasedEnvelope.parse(definition.pluginCommand);
    const state = JSON.parse(row.state_json) as Record<string, unknown>;
    if (!occurrence || envelope.hostProcessId === hostProcessId) {
      return { envelope, state, retired: false };
    }
    const { nextRunAtMs: _next, startupCatchupAtMs: _catchup, ...retiredState } = state;
    db.prepare(
      "UPDATE cron_jobs SET enabled = 0, state_json = ?, job_json = json_set(job_json, '$.enabled', json('false')) WHERE store_key = ? AND job_id = ?",
    ).run(JSON.stringify(retiredState), storeKey, jobId);
    return { envelope, state, retired: true };
  });
}

const host: PluginCommandScheduleHost = {
  pluginId: "watcher",
  pluginIncarnation: "after-rollback-incarnation",
  pluginSource: "/plugins/watcher/index.js",
  pluginRoot: "/plugins/watcher",
  pluginVersion: "1.0.0",
  sourceDigest: "accepted-code-digest",
  commands: ["watcher-resume"],
};
const create = (id: string): CronJobCreate => ({
  id,
  declarationKey: "plugin:watcher:" + id,
  name: "Watcher",
  agentId: "main",
  enabled: true,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: {
    kind: "agentTurn",
    message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
    toolsAllow: ["sessions_spawn", "agents_wait"],
  },
  delivery: { mode: "none" },
});

async function acceptedBeforeRestart(label: string, sourceDigest = host.sourceDigest) {
  const queue = await queueStore(
    fixture.statePath("cron", label + ".json"),
    [],
    now,
    () => context,
  );
  const added = await executeOpenClawStateWorker(context, {
    type: "cron.mutateJobs",
    input: {
      storeKey: queue.storeKey,
      jobMutation: {
        kind: "add",
        input: create(label),
        options: {
          captured: false,
          pluginCommand: pluginCommandSchedule(now, { hostProcessId: previous, maxRuns: 3 }),
          pluginCommandSourceDigest: sourceDigest,
        },
      },
      snapshot: { nowMs: now },
    },
  });
  if (!("outcome" in added)) {
    throw new Error("expected command creation");
  }
  return queue;
}

async function claimAfterRestart(
  queue: Awaited<ReturnType<typeof acceptedBeforeRestart>>,
  hosts: PluginCommandScheduleHost[] = [host],
  receiptId = "cron:request:after-restart",
) {
  const job = (await queue.read()).jobs[0]!;
  const request = requestFor(job, { receiptId, mode: "force" });
  const requested = await queue.request([request]);
  return { requested, drained: await queue.drain([request], 1, false, hosts), job };
}

it("an older reader ignores restart continuity and ends the schedule; upgrading never revives it", async () => {
  const queue = await acceptedBeforeRestart("rolled-back");
  // Rollback: the released Gateway starts as another process and reaches the occurrence.
  const released = await claimWithReleasedReader(queue.storeKey, "rolled-back", true);
  expect(released.retired).toBe(true);
  // It decoded the unchanged envelope and carried continuity along as opaque job state.
  expect(released.envelope).toMatchObject({ hostProcessId: previous, maxRuns: 3 });
  expect(released.state).toMatchObject({
    pluginCommandRuns: 0,
    pluginCommandBinding: { hostProcessId: previous },
  });
  // Upgrading again: the retired schedule is terminal even with its plugin loaded.
  const { requested, drained, job } = await claimAfterRestart(queue);
  expect(job.enabled).toBe(false);
  expect(requested.accepted).toEqual([]);
  expect(drained.launches).toEqual([]);
  expect((await queue.read()).jobs[0]).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 0, pluginCommandBinding: { hostProcessId: previous } },
  });
});

it("a schedule an older reader never reached is re-armed after upgrading again", async () => {
  const queue = await acceptedBeforeRestart("untouched");
  // The released Gateway loads the row without error but stops before its next occurrence.
  const released = await claimWithReleasedReader(queue.storeKey, "untouched", false);
  expect(released.retired).toBe(false);
  const { drained } = await claimAfterRestart(queue);
  expect(drained.launches).toHaveLength(1);
  expect(drained.launches[0]?.job.state).toMatchObject({
    pluginCommandRuns: 1,
    pluginCommandBinding: {
      hostProcessId: currentPluginCommandHostProcessId(),
      pluginIncarnation: host.pluginIncarnation,
      sourceDigest: host.sourceDigest,
    },
  });
});

it("a reader without bundled build identities ends a core-bundled schedule; the same build never revives it", async () => {
  // A core-bundled plugin's code identity is its exact loaded build, in the released binding field.
  const bundled = { ...host, sourceDigest: "bundled-build:" + "b".repeat(64) };
  const queue = await acceptedBeforeRestart("bundled-rolled-back", bundled.sourceDigest);
  // Rollback: a Gateway with restart continuity but no bundled identities lists no loaded host for
  // core-bundled plugins, so its claim finds no matching code and retires the schedule.
  const rolledBack = await claimAfterRestart(queue, [], "cron:request:rolled-back");
  expect(rolledBack.drained.launches).toEqual([]);
  expect((await queue.read()).jobs[0]).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 0, pluginCommandBinding: { hostProcessId: previous } },
  });
  // Upgrading again onto the accepting build: the retired schedule stays ended.
  const { requested, drained, job } = await claimAfterRestart(
    queue,
    [bundled],
    "cron:request:bundled-upgraded-again",
  );
  expect(job.enabled).toBe(false);
  expect(requested.accepted).toEqual([]);
  expect(drained.launches).toEqual([]);
  expect((await queue.read()).jobs[0]).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 0 },
  });
});

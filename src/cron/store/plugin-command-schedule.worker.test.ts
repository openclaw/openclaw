import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { loseFirstCronMutationReply } from "../../../test/helpers/cron/runtime-mutation.js";
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
import { resolveCronJobConfigRevision } from "../config-revision.js";
import {
  currentPluginCommandHostProcessId,
  MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT,
} from "../plugin-command-schedule.js";
import { pluginCommandSchedule } from "../plugin-command-schedule.test-support.js";
import {
  PLUGIN_COMMAND_SCHEDULE_MESSAGE,
  type PluginCommandScheduleHost,
} from "../plugin-command-schedule.types.js";
import type { CronJob, CronJobCreate, CronStoredJob } from "../types.js";
import type { CronJobMutation } from "./job-mutations.types.js";
import { readCronRunHistoryCandidates } from "./read-only.js";
import {
  queueJob,
  queueStore,
  requestFor,
  requestForJob,
  scheduled,
  type QueueRequest,
} from "./run-queue.test-support.js";
import type { CronQueuedRun } from "./run-queue.types.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";

const now = 1_800_000_000_000;
let fixture: OpenClawTestState;
let context: OpenClawStateWorkerContext;

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "plugin-command-budgets" });
  context = captureOpenClawStateWorkerContext();
  await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
});
afterAll(async () => {
  await fixture?.cleanup();
});

const reservedPayload = {
  kind: "agentTurn",
  message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
  toolsAllow: ["sessions_spawn", "agents_wait"],
} as const;
const commandJob = (id: string, overrides: Partial<CronStoredJob> = {}): CronStoredJob => ({
  ...queueJob(id, now),
  payload: { ...reservedPayload, toolsAllow: [...reservedPayload.toolsAllow] },
  pluginCommand: pluginCommandSchedule(now),
  state: { nextRunAtMs: now, pluginCommandRuns: 0 },
  ...overrides,
});
const store = (label: string, jobs: CronStoredJob[]) =>
  queueStore(fixture.statePath("cron", label + ".json"), jobs, now, () => context);
const mutate = (storeKey: string, jobMutation: CronJobMutation, nowMs = now + 1) =>
  executeOpenClawStateWorker(context, {
    type: "cron.mutateJobs",
    input: { storeKey, jobMutation, snapshot: { nowMs } },
  });
const commandCreate = (id: string, declarationKey = "plugin:watcher:" + id): CronJobCreate => ({
  id,
  declarationKey,
  name: "Watcher",
  agentId: "main",
  enabled: true,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { ...reservedPayload, toolsAllow: [...reservedPayload.toolsAllow] },
  delivery: { mode: "none" },
});
async function createCommand(
  storeKey: string,
  input: CronJobCreate,
  options: Extract<CronJobMutation, { kind: "add" }>["options"],
  nowMs = now + 1,
) {
  const result = await mutate(storeKey, { kind: "add", input, options }, nowMs);
  if (!("outcome" in result)) {
    throw new Error("Expected command creation");
  }
  return result.outcome.store.jobs;
}
const previous = "1:previous-boot";
const restartedHost = {
  pluginId: "watcher",
  pluginIncarnation: "restarted-incarnation",
  pluginSource: "/plugins/watcher/index.js",
  pluginRoot: "/plugins/watcher",
  pluginVersion: "1.0.0",
  sourceDigest: "digest-a",
  commands: ["watcher-resume"],
};
function restartable(id: string, runs = 0) {
  const pluginCommand = pluginCommandSchedule(now, { hostProcessId: previous, maxRuns: 3 });
  return commandJob(id, {
    pluginCommand,
    state: {
      nextRunAtMs: now,
      pluginCommandRuns: runs,
      pluginCommandBinding: {
        hostProcessId: previous,
        pluginIncarnation: pluginCommand.pluginIncarnation,
        sourceDigest: "digest-a",
      },
    },
  });
}
async function withStateDatabase<T>(
  read: (db: ReturnType<typeof openOpenClawStateDatabase>["db"]) => T,
) {
  await closeOpenClawStateDatabaseAsync();
  try {
    return read(openOpenClawStateDatabase().db);
  } finally {
    await closeOpenClawStateDatabaseAsync();
    // Reopening replaces the database admission that the captured worker context names.
    context = captureOpenClawStateWorkerContext();
  }
}

it("charges only an activated launch, retires on the final charge, and never refunds recovery", async () => {
  const blocker = queueJob("capacity-owner", now);
  const command = commandJob("bounded-command", {
    pluginCommand: pluginCommandSchedule(now, { maxRuns: 1 }),
  });
  const queue = await store("capacity-and-recovery", [blocker, command]);
  const requests = [blocker, command].map((job) => scheduled(queue.storeKey, job, now));
  await queue.request(requests);
  expect((await queue.read()).jobs[1]?.state.pluginCommandRuns).toBe(0);
  expect((await queue.drain()).launches.map(({ job }) => job.id)).toEqual([blocker.id]);
  expect((await queue.read()).jobs[1]?.state.pluginCommandRuns).toBe(0);
  await queue.cancel([requests[0]!.receiptId], "superseded");
  const preparing = await executeOpenClawStateWorker(context, {
    type: "cron.drainQueue",
    input: {
      storeKey: queue.storeKey,
      nowMs: now + 1,
      requests: [],
      maxConcurrentRuns: 1,
      preparingAgentIds: ["main"],
    },
  });
  expect(preparing.launches).toEqual([]);
  expect(preparing.preparing.map(({ job }) => job.id)).toEqual([command.id]);
  expect((await queue.read()).jobs[1]).toMatchObject({
    enabled: true,
    state: { pluginCommandRuns: 0 },
  });
  const launched = await queue.drain();
  expect(launched.launches).toHaveLength(1);
  // The last allowed attempt still launches, but the same transaction disarms the schedule.
  expect(launched.launches[0]?.job).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 1, runningAtMs: now + 1 },
  });
  expect(launched.launches[0]?.job.state.nextRunAtMs).toBeUndefined();
  const stored = (await queue.read()).jobs[1]!;
  expect(stored).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 1 },
  });
  expect(stored.state.nextRunAtMs).toBeUndefined();
  expect((await queue.drain()).launches).toEqual([]);
  await queue.recover();
  const recovered = (await queue.read()).jobs[1]!;
  expect(recovered).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 1 },
  });
  expect(recovered.state.runningAtMs).toBeUndefined();
  // A retired command schedule cannot be force-run back into another attempt.
  const retry = requestFor(recovered, { receiptId: "cron:request:after-crash", mode: "force" });
  expect(await queue.request([retry])).toMatchObject({
    accepted: [],
    rejected: [{ receiptId: retry.receiptId, reason: "job-ineligible" }],
  });
  expect((await queue.read()).jobs[1]?.state.pluginCommandRuns).toBe(1);
});

it.each([
  [
    "deadline",
    {
      ...restartable("deadline"),
      pluginCommand: pluginCommandSchedule(now, { hostProcessId: previous, deadlineAtMs: now + 1 }),
    },
    "schedule deadline expired",
  ],
  ["exhausted", { ...restartable("exhausted", 3) }, "schedule maxRuns exhausted"],
  ["missing-count", { state: { nextRunAtMs: now } }, "run counter is missing or invalid"],
  [
    "negative-count",
    { state: { nextRunAtMs: now, pluginCommandRuns: -1 } },
    "run counter is missing or invalid",
  ],
  [
    "missing-envelope",
    { pluginCommand: undefined, state: { nextRunAtMs: now } },
    "schedule budget is missing or invalid",
  ],
] as const)(
  "retires %s before spending a run and never wakes it again",
  async (label, overrides, reason) => {
    const error = `cron: plugin command ${reason}`;
    const job = commandJob(label, overrides);
    const queue = await store(label, [job]);
    const request = scheduled(queue.storeKey, job, now);
    expect((await queue.request([request])).accepted).toHaveLength(1);
    const drained = await queue.drain([], 1, false, [restartedHost]);
    expect(drained.launches).toEqual([]);
    expect(drained.skipped).toMatchObject([{ error, job: { enabled: false } }]);
    const retired = (await queue.read()).jobs[0]!;
    expect(retired.enabled).toBe(false);
    expect(retired.state.nextRunAtMs).toBeUndefined();
    expect(retired.state.pluginCommandRuns).toBe(job.state.pluginCommandRuns);
    if (job.state.pluginCommandBinding) {
      expect(retired.state.pluginCommandBinding).toEqual(job.state.pluginCommandBinding);
    }
    expect((await queue.history()).entries).toMatchObject([{ status: "skipped", error }]);
    const later = requestFor(retired, { receiptId: "cron:request:" + label, mode: "force" });
    expect((await queue.request([later])).rejected).toMatchObject([{ reason: "job-ineligible" }]);
    expect((await queue.history()).entries).toHaveLength(1);
  },
);

it("re-arms a restartable schedule onto the matching loaded plugin inside its claim", async () => {
  const host = restartedHost;
  const launch = async (label: string, job: CronStoredJob, hosts: (typeof host)[]) => {
    const queue = await store(label, [job]);
    await queue.request([scheduled(queue.storeKey, job, now)]);
    return { queue, drained: await queue.drain([], 1, false, hosts) };
  };

  const { queue, drained } = await launch("rearm", restartable("rearm", 1), [
    { ...host, pluginVersion: "2.0.0" },
    host,
  ]);
  expect(drained.skipped).toEqual([]);
  expect(drained.launches).toHaveLength(1);
  const binding = {
    hostProcessId: currentPluginCommandHostProcessId(),
    pluginIncarnation: host.pluginIncarnation,
    sourceDigest: "digest-a",
  };
  // The re-arm, the budget check and the monotonic charge commit in one claim.
  expect(drained.launches[0]?.job).toMatchObject({
    enabled: true,
    state: { pluginCommandRuns: 2, pluginCommandBinding: binding },
    // The envelope keeps the released shape and its original facts.
    pluginCommand: restartable("rearm").pluginCommand,
  });
  expect((await queue.read()).jobs[0]?.state).toMatchObject({
    pluginCommandRuns: 2,
    pluginCommandBinding: binding,
  });
  // A second claim while the occurrence runs, as a racing recovery or force request would, cannot
  // launch it again or move the binding.
  const racing = requestFor((await queue.read()).jobs[0]!, {
    receiptId: "cron:request:race",
    mode: "force",
  });
  await queue.request([racing]);
  expect(
    (await queue.drain([], 1, false, [{ ...host, pluginIncarnation: "other" }])).launches,
  ).toEqual([]);
  // Recovery after a crash never refunds the attempt and keeps the restart binding.
  await queue.recover();
  expect((await queue.read()).jobs[0]?.state).toMatchObject({
    pluginCommandRuns: 2,
    pluginCommandBinding: binding,
  });

  // Without the same plugin build and command loaded, the claim retires it before any attempt.
  for (const [label, hosts] of [
    ["no-plugin", []],
    ["other-version", [{ ...host, pluginVersion: "2.0.0" }]],
    ["other-source", [{ ...host, pluginSource: "/plugins/other/index.js" }]],
    // The same location and metadata, but different loaded code.
    ["other-code", [{ ...host, sourceDigest: "digest-b" }]],
    ["command-gone", [{ ...host, commands: ["other-command"] }]],
  ] satisfies Array<[string, (typeof host)[]]>) {
    const refused = await launch(label, restartable(label), hosts);
    expect(refused.drained.launches).toEqual([]);
    expect(refused.drained.skipped).toMatchObject([
      {
        error: "cron: plugin command schedule has no matching loaded plugin after Gateway restart",
        job: { enabled: false, state: { pluginCommandRuns: 0 } },
      },
    ]);
    expect((await refused.queue.read()).jobs[0]?.state.pluginCommandBinding?.hostProcessId).toBe(
      previous,
    );
  }
});

it.each([
  ["is not replayed once its command may have started", true],
  ["is retried once when it never reached its command", false],
])("an occurrence interrupted by a restart %s", async (_label, started) => {
  const job = {
    ...restartable(started ? "interrupted-started" : "interrupted-unstarted"),
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
  } satisfies CronStoredJob;
  const host = restartedHost;
  const queue = await store(job.id, [job]);
  await queue.request([scheduled(queue.storeKey, job, now)]);
  const first = await queue.drain([], 1, false, [host]);
  expect(first.launches).toHaveLength(1);
  if (started) {
    // The occurrence passed its delivery fence, so its command may have run.
    await executeOpenClawStateWorker(context, {
      type: "cron.markDeliveryStarted",
      input: { storeKey: queue.storeKey, handle: first.launches[0]!.runReceipt, snapshot: {} },
    });
  }
  // The Gateway dies mid-occurrence; the next process recovers the abandoned receipt.
  await queue.recover();
  const recovered = (await queue.read()).jobs[0]!;
  expect(recovered.state).toMatchObject({ pluginCommandRuns: 1 });
  expect(recovered.state.runningAtMs).toBeUndefined();
  const retryAtMs = recovered.state.startupCatchupAtMs;
  if (started) {
    expect(retryAtMs).toBeUndefined();
    // It waits for the next regular slot instead.
    expect(recovered.state.nextRunAtMs).toBeGreaterThanOrEqual(now + 60_000);
    return;
  }
  // Only an occurrence that never reached its command is retried, once, as a charged attempt.
  expect(retryAtMs).toBeGreaterThan(now);
  expect(recovered.state.nextRunAtMs).toBe(retryAtMs);
  const retry = scheduled(queue.storeKey, recovered, retryAtMs!);
  await queue.request([retry, retry], retryAtMs);
  const retried = await queue.drain([], 1, false, [host]);
  expect(retried.launches).toHaveLength(1);
  expect(retried.launches[0]?.job.state.pluginCommandRuns).toBe(2);
});

it("bounds active command schedules per plugin and parent; retired schedules do not count", async () => {
  const key = fixture.statePath("cron", "active-cap.json");
  const options = { captured: false, pluginCommand: pluginCommandSchedule(now) };
  const add = (index: number) =>
    mutate(key, {
      kind: "add",
      input: commandCreate("cap-" + index, "plugin:watcher:cap:" + index),
      options,
    });
  for (let index = 0; index < MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT; index += 1) {
    await add(index);
  }
  await expect(add(100)).rejects.toThrow(/limited to 8 active jobs per plugin and parent/);
  // Another parent has its own budget.
  await mutate(key, {
    kind: "add",
    input: commandCreate("other-parent", "plugin:watcher:other-parent"),
    options: {
      captured: false,
      pluginCommand: pluginCommandSchedule(now, {
        parent: { agentId: "main", sessionKey: "agent:main:other", sessionId: "other" },
      }),
    },
  });
  await mutate(key, {
    kind: "update",
    id: "cap-0",
    patch: { enabled: false },
    options: { captured: false },
  });
  await expect(add(101)).resolves.toMatchObject({ outcome: { changed: true } });
});

it("counts schedules a restart can re-arm; schedules that can never run do not hold the cap", async () => {
  const seeded = (
    id: string,
    overrides: Parameters<typeof pluginCommandSchedule>[1],
    bound = true,
    sourceDigest = "digest-a",
  ) => {
    const pluginCommand = pluginCommandSchedule(now, overrides);
    return commandJob(id, {
      pluginCommand,
      state: {
        nextRunAtMs: now + 30_000,
        pluginCommandRuns: 0,
        ...(bound
          ? {
              pluginCommandBinding: {
                hostProcessId: pluginCommand.hostProcessId,
                pluginIncarnation: pluginCommand.pluginIncarnation,
                sourceDigest,
              },
            }
          : {}),
      },
    });
  };
  const seed = Array.from(
    { length: MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT },
    (_, index) => [
      seeded("unbound-previous-" + index, { hostProcessId: previous }, false),
      seeded("replaced-instance-" + index, { pluginIncarnation: "replaced-incarnation" }),
      seeded("other-build-" + index, { hostProcessId: previous, pluginVersion: "0.9.0" }),
      seeded("expired-" + index, { hostProcessId: previous, deadlineAtMs: now }),
      seeded("other-code-" + index, { hostProcessId: previous }, true, "digest-b"),
      ...(index < MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT / 2
        ? [seeded("surviving-" + index, { hostProcessId: previous })]
        : []),
    ],
  ).flat();
  const queue = await store("stale-cap", seed);
  const add = (id: string) =>
    mutate(queue.storeKey, {
      kind: "add",
      input: commandCreate(id, "plugin:watcher:" + id),
      options: {
        captured: false,
        pluginCommand: pluginCommandSchedule(now),
        pluginCommandSourceDigest: "digest-a",
      },
    });
  for (let index = 0; index < MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT / 2; index += 1) {
    await expect(add("current-" + index)).resolves.toMatchObject({ outcome: { changed: true } });
  }
  await expect(add("current-overflow")).rejects.toThrow(
    /limited to 8 active jobs per plugin and parent/,
  );
  const stored = await queue.read();
  const enabled = stored.jobs.filter((job) => job.enabled).map((job) => job.id);
  expect(enabled).toHaveLength(6 * MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT);
  expect(enabled).not.toContain("current-overflow");
  // Every schedule this host accepts records restart continuity, privately in job state.
  expect(stored.jobs.find((job) => job.id === "current-0")?.state.pluginCommandBinding).toEqual({
    hostProcessId: currentPluginCommandHostProcessId(),
    pluginIncarnation: "synthetic-plugin-incarnation",
    sourceDigest: "digest-a",
  });
});

it("keeps a schedule accepted without captured plugin source bound to its Gateway process", async () => {
  const key = fixture.statePath("cron", "no-source-digest.json");
  const [job] = await createCommand(key, commandCreate("no-digest"), {
    captured: false,
    pluginCommand: pluginCommandSchedule(now, { hostProcessId: previous }),
  });
  // No code identity, so no restart continuity: it ends with the process that accepted it.
  expect(job!.state.pluginCommandBinding).toBeUndefined();
  const queue = await store("no-source-digest", [
    { ...job!, state: { ...job!.state, nextRunAtMs: now } },
  ]);
  await queue.request([scheduled(queue.storeKey, job!, now)]);
  const drained = await queue.drain([], 1, false, [restartedHost]);
  expect(drained.launches).toEqual([]);
  expect(drained.skipped).toMatchObject([
    { error: "cron: plugin command schedule ended with its Gateway process" },
  ]);
});

it("keeps an identical declaration and consumed counter unchanged; refuses rewrites and rearming", async () => {
  const input = commandCreate("immutable-declaration", "plugin:watcher:workflow");
  const key = fixture.statePath("cron", "immutable.json");
  const options = { captured: false, pluginCommand: pluginCommandSchedule(now, { maxRuns: 2 }) };
  const jobs = await createCommand(key, input, options);
  expect(jobs[0]?.state.pluginCommandRuns).toBe(0);
  const queue = await store("immutable", jobs);
  const current = (await queue.read()).jobs[0]!;
  const request = requestFor(current, { receiptId: "cron:request:declaration", mode: "force" });
  await queue.request([request]);
  await queue.drain([request]);
  await queue.cancel([request.receiptId], "superseded");
  const before = await queue.read();
  expect(before.jobs[0]?.state.pluginCommandRuns).toBe(1);
  const duplicate = await mutate(key, {
    kind: "add",
    input: { ...input, id: "ignored-retry-id" },
    options,
  });
  expect(duplicate).toMatchObject({ outcome: { changed: false, store: before } });
  const rewrites: CronJobMutation[] = [
    { kind: "add", input: { ...input, name: "Different" }, options },
    { kind: "add", input: { ...input, schedule: { kind: "every", everyMs: 1_000 } }, options },
    {
      kind: "add",
      input,
      options: { ...options, pluginCommand: pluginCommandSchedule(now, { maxRuns: 100 }) },
    },
    { kind: "add", input, options: { captured: false } },
    { kind: "update", id: current.id, patch: { enabled: true }, options: { captured: false } },
    {
      kind: "update",
      id: current.id,
      patch: { payload: { kind: "command", argv: ["echo", "changed"] } },
      options: { captured: false },
    },
  ];
  for (const mutation of rewrites) {
    await expect(mutate(key, mutation)).rejects.toThrow(/plugin command/);
    expect(await queue.read()).toEqual(before);
  }
  await queue.update(current.id, { enabled: false });
  const disabled = (await queue.read()).jobs[0]!;
  expect(disabled.enabled).toBe(false);
  expect(disabled.state.pluginCommandRuns).toBe(1);
  expect(disabled.pluginCommand).toEqual(before.jobs[0]?.pluginCommand);
  // Disable withdraws unattended authority: a manual force run cannot spend the last attempt.
  const forced = requestFor(disabled, { receiptId: "cron:request:disabled", mode: "force" });
  expect((await queue.request([forced])).rejected).toMatchObject([{ reason: "job-ineligible" }]);
  expect((await queue.read()).jobs[0]?.state.pluginCommandRuns).toBe(1);
  await expect(mutate(key, { kind: "add", input, options })).rejects.toThrow(
    /cannot be changed or rearmed/,
  );
});

it("rejects caller-authored run accounting on ordinary add and update paths", async () => {
  const key = fixture.statePath("cron", "authored-state.json");
  const input = { ...queueJob("ordinary", now), state: { lastRunAtMs: now, pluginCommandRuns: 0 } };
  await expect(mutate(key, { kind: "add", input, options: { captured: false } })).rejects.toThrow(
    /private launch accounting/,
  );
  const queue = await store("authored-state", [queueJob("ordinary", now)]);
  const patch = { state: { lastRunAtMs: now, pluginCommandRuns: 0 } };
  await expect(queue.update("ordinary", patch)).rejects.toThrow(/private launch accounting/);
  expect((await queue.read()).jobs[0]?.state).not.toHaveProperty("pluginCommandRuns");
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
  ...restartedHost,
  pluginIncarnation: "after-rollback-incarnation",
  sourceDigest: "accepted-code-digest",
};
async function acceptedBeforeRestart(label: string, sourceDigest = host.sourceDigest) {
  const queue = await store(label, []);
  await createCommand(
    queue.storeKey,
    commandCreate(label),
    {
      captured: false,
      pluginCommand: pluginCommandSchedule(now, { hostProcessId: previous, maxRuns: 3 }),
      pluginCommandSourceDigest: sourceDigest,
    },
    now,
  );
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

const jobIds = (runs: CronQueuedRun[]) => runs.map(({ job }) => job.id);
const runIds = (runs: { runReceipt: CronRunReceiptHandle }[]) =>
  runs.map(({ runReceipt }) => runReceipt.receiptId);
const rejected = (request: QueueRequest, reason = "already-requested") => [
  { jobId: request.jobId, receiptId: request.receiptId, reason },
];
const job = (id: string, overrides?: Partial<CronJob>) => queueJob(id, now, overrides);
async function scheduledQueue(id: string, overrides?: Partial<CronJob>) {
  const current = job(id, overrides);
  const queue = await store(id, [current]);
  return { current, queue, request: scheduled(queue.storeKey, current, now) };
}

it("keeps the first execution link across binding retries without changing the run claim", async () => {
  const { queue, request } = await scheduledQueue("execution-link");
  await queue.request([request]);
  const activated = await queue.drain();
  expect(activated.launches).toHaveLength(1);
  const receipt = activated.launches[0]!.runReceipt;
  const bind = (contextId: string, executionId: string) =>
    executeOpenClawStateWorker(context, {
      type: "cron.bindReceiptExecution",
      input: { receiptId: receipt.receiptId, binding: { contextId, executionId } },
    });

  expect(await bind("original-context", "original-execution")).toBe(true);
  expect(await bind("replacement-context", "replacement-execution")).toBe(false);
  expect(await bind("original-context", "original-execution")).toBe(true);
  expect(await queue.readReceipt(receipt)).toEqual(receipt);
  await queue.cancel([receipt.receiptId], "superseded");
  expect((await readCronRunHistoryCandidates(queue.storeKey, "execution-link")).records).toEqual(
    [],
  );
});

it("returns durable receipt handles across queued edits and records disabled requests under their public ID", async () => {
  const { current: original, queue, request } = await scheduledQueue("edited");
  const claimed = (await queue.request([request])).accepted[0]!;
  expect(await queue.readReceipt(claimed.runReceipt)).toEqual(claimed.runReceipt);
  const payload = { kind: "command" as const, argv: ["echo", "new payload"] };
  const edited = await queue.update(original.id, { payload, agentId: "edited-agent" });
  expect(edited).toMatchObject({ outcome: { store: { jobs: [{ state: { queuedAtMs: now } }] } } });
  const activated = (await queue.drain()).launches[0]!;
  expect(activated.job.payload).toEqual(payload);
  expect(activated.runReceipt).toEqual({
    ...claimed.runReceipt,
    agentId: "edited-agent",
    configRevision: resolveCronJobConfigRevision(activated.job),
    startedAtMs: now + 1,
  });
  expect(await queue.readReceipt(activated.runReceipt)).toEqual(activated.runReceipt);
  expect((await queue.request([request])).rejected).toEqual(rejected(request));

  const cancelJob = job("disabled");
  const cancelled = await store("disable", [cancelJob]);
  const manual = requestFor(cancelJob, {
    receiptId: "cron:request:disabled",
    requestRunId: "public-ack",
    mode: "if-enabled" as const,
  });
  await cancelled.request([manual]);
  const disabled = await cancelled.update(cancelJob.id, { enabled: false });
  expect(disabled).toMatchObject({ outcome: { store: await cancelled.read() } });
  const disabledJob = "outcome" in disabled ? disabled.outcome.store.jobs[0] : undefined;
  expect(disabledJob?.enabled).toBe(false);
  expect(disabledJob?.state.queuedAtMs).toBeUndefined();
  const drained = await cancelled.drain([manual]);
  expect(drained.launches).toEqual([]);
  expect(runIds(drained.skipped)).toEqual([manual.receiptId]);
  expect((await cancelled.read()).jobs[0]?.state.queuedAtMs).toBeUndefined();
  const page = await cancelled.history("public-ack");
  expect(page.entries).toMatchObject([
    {
      status: "skipped",
      runId: "public-ack",
      error: "cron: queued job schedule changed or was disabled",
    },
  ]);
});

it("holds scheduled requests while paused and activates an explicit request behind them", async () => {
  const jobs = [job("timed-paused"), job("manual-paused")];
  const queue = await store("paused", jobs);
  const timed = scheduled(queue.storeKey, jobs[0]!, now);
  const manual = requestFor(jobs[1]!, {
    receiptId: "cron-request.paused",
    mode: "force" as const,
  });
  await queue.request([timed, manual]);
  const paused = await queue.drain([manual], 1, true);
  expect(jobIds(paused.launches)).toEqual(["manual-paused"]);
  expect(paused.skipped).toEqual([]);
  expect((await queue.read()).jobs[0]?.state.queuedAtMs).toBe(now);
  await queue.cancel([manual.receiptId], "superseded");
  expect(jobIds((await queue.drain()).launches)).toEqual(["timed-paused"]);
});

it("launches explicit force on a disabled job and retains a consumed exit event through rearming", async () => {
  const disabled = job("force", { enabled: false });
  const forced = await store("force", [disabled]);
  const force = requestFor(disabled, {
    receiptId: "cron:request:force",
    mode: "force" as const,
    preserveSchedule: true,
  });
  expect((await forced.request([force])).accepted).toHaveLength(1);
  expect((await forced.drain([force])).launches[0]?.job.enabled).toBe(false);

  const onExit = job("exit", {
    schedule: { kind: "on-exit", command: "synthetic-watch" },
    state: {},
  });
  const exit = await store("exit", [onExit]);
  const event = requestForJob(exit.storeKey, onExit, now);
  expect((await exit.request([event])).accepted[0]?.job.enabled).toBe(false);
  await exit.update(onExit.id, { enabled: true });
  const result = await exit.drain([event]);
  expect(result.skipped).toEqual([]);
  expect(jobIds(result.launches)).toEqual(["exit"]);
});

it("recovers a timed request without replaying active work or reconstructing a lost manual payload", async () => {
  const { queue, request } = await scheduledQueue("recover", {
    schedule: { kind: "at", at: new Date(now).toISOString() },
  });
  const requested = (await queue.request([request])).accepted[0]!;
  expect((await queue.recover()).jobs[0]?.state.queuedAtMs).toBe(now);
  const active = (await queue.drain()).launches[0]!;
  expect(active.runReceipt.receiptId).toBe(requested.runReceipt.receiptId);
  expect((await queue.recover()).interruptedRuns).toHaveLength(1);
  expect((await queue.drain()).launches).toEqual([]);
  const interrupted = (await queue.read()).jobs[0]!;
  expect(interrupted).toMatchObject({
    enabled: false,
    state: { lastRunStatus: "error" },
  });
  expect(interrupted.state.runningAtMs).toBeUndefined();

  const manualJob = job("legacy");
  const legacy = await store("legacy", [manualJob]);
  const manual = requestFor(manualJob, {
    receiptId: "old-random-receipt-id",
    mode: "force" as const,
  });
  await legacy.request([manual]);
  const held = await legacy.drain();
  expect(held).toEqual({ launches: [], preparing: [], skipped: [] });
  expect((await legacy.read()).jobs[0]?.state.queuedAtMs).toBe(now);
  await legacy.recover();
  expect((await legacy.read()).jobs[0]?.state.queuedAtMs).toBeUndefined();
  expect((await legacy.drain()).launches).toEqual([]);
  const history = await legacy.history();
  expect(history.entries).toMatchObject([
    { status: "skipped", error: "cron: queued request lost its launch context" },
  ]);
});

it.each(["request", "cancellation"] as const)(
  "recovers a committed %s after losing its worker reply without replay",
  async (phase) => {
    const { queue, request } = await scheduledQueue(`lost-${phase}`);
    if (phase === "cancellation") {
      await queue.request([request]);
    }
    const reply = loseFirstCronMutationReply(
      phase === "request" ? "cron.requestRuns" : "cron.cancelRequests",
    );
    try {
      await expect(
        phase === "request" ? queue.request([request]) : queue.cancel([request.receiptId]),
      ).rejects.toBeInstanceOf(Error);
      await reply.waitForExit();
      expect(reply.wasDropped()).toBe(true);
      expect(reply.attempts).toEqual([
        phase === "request" ? "cron.requestRuns" : "cron.cancelRequests",
      ]);
    } finally {
      await reply.close();
    }
    context = captureOpenClawStateWorkerContext();
    if (phase === "request") {
      expect((await queue.read()).jobs[0]?.state.queuedAtMs).toBe(now);
      const resumed = await queue.drain();
      expect(runIds(resumed.launches)).toEqual([request.receiptId]);
      expect((await queue.request([request])).rejected[0]?.reason).toBe("already-requested");
    } else {
      expect((await queue.read()).jobs[0]?.state.queuedAtMs).toBeUndefined();
      expect((await queue.drain()).launches).toEqual([]);
      const history = await queue.history();
      expect(history.entries).toMatchObject([{ status: "skipped" }]);
    }
  },
);

it("cancels a removed queued job and rejects a plan made before its definition changed", async () => {
  const { current, queue, request } = await scheduledQueue("removed");
  await queue.request([request]);
  await queue.remove(current.id);
  expect((await queue.drain([request])).skipped[0]?.runReceipt.receiptId).toBe(request.receiptId);
  expect((await queue.drain()).launches).toEqual([]);
  const { current: changed, queue: stale, request: staleRequest } = await scheduledQueue("changed");
  await stale.update(changed.id, { enabled: false });
  expect((await stale.request([staleRequest])).rejected).toEqual(
    rejected(staleRequest, "job-ineligible"),
  );
});

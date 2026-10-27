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
import type { CronJobCreate, CronJobPatch, CronStoredJob } from "../types.js";
import type { CronJobMutation } from "./job-mutations.types.js";
import {
  queueJob,
  queueStore,
  requestFor,
  scheduled,
  type QueueRequest,
} from "./run-queue.test-support.js";
import type { CronQueuedRun } from "./run-queue.types.js";

const now = 1_800_000_000_000;
let fixture: OpenClawTestState;
let context: OpenClawStateWorkerContext;

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "plugin-command-budgets" });
  context = captureOpenClawStateWorkerContext();
  await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
});
afterAll(() => fixture?.cleanup());

const reservedPayload = {
  kind: "agentTurn",
  message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
  toolsAllow: ["sessions_spawn", "agents_wait"],
} as const;
const launchState = (pluginCommandRuns?: number) => ({ nextRunAtMs: now, pluginCommandRuns });
const commandJob = (id: string, overrides: Partial<CronStoredJob> = {}): CronStoredJob => ({
  ...queueJob(id, now),
  payload: { ...reservedPayload, toolsAllow: [...reservedPayload.toolsAllow] },
  pluginCommand: pluginCommandSchedule(now),
  state: launchState(0),
  ...overrides,
});
const store = (label: string, jobs: CronStoredJob[]) =>
  queueStore(fixture.statePath("cron", label + ".json"), jobs, now, () => context);
const mutate = (storeKey: string, jobMutation: CronJobMutation, nowMs = now + 1) =>
  executeOpenClawStateWorker(context, {
    type: "cron.mutateJobs",
    input: { storeKey, jobMutation, snapshot: { nowMs } },
  });
type AddOptions = Extract<CronJobMutation, { kind: "add" }>["options"];
const addCommand = (storeKey: string, input: CronJobCreate, options: AddOptions, nowMs = now + 1) =>
  mutate(storeKey, { kind: "add", input, options }, nowMs);
const updateCommand = (id: string, patch: CronJobPatch): CronJobMutation => ({
  kind: "update",
  id,
  patch,
  options: { captured: false },
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
  options: AddOptions,
  nowMs = now + 1,
) {
  const result = await addCommand(storeKey, input, options, nowMs);
  if (!("outcome" in result)) {
    throw new Error("Expected command creation");
  }
  return result.outcome.store.jobs;
}
async function requestCommand(label: string, job: CronStoredJob) {
  const queue = await store(label, [job]);
  await queue.request([scheduled(queue.storeKey, job, now)]);
  return queue;
}
function expectBudget(job: CronStoredJob | undefined, enabled: boolean, runs: number) {
  expect(job).toMatchObject({ enabled, state: { pluginCommandRuns: runs } });
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
function restartable(
  id: string,
  runs = 0,
  overrides: Parameters<typeof pluginCommandSchedule>[1] = { hostProcessId: previous, maxRuns: 3 },
  sourceDigest = "digest-a",
) {
  const pluginCommand = pluginCommandSchedule(now, overrides);
  return commandJob(id, {
    pluginCommand,
    state: {
      ...launchState(runs),
      pluginCommandBinding: {
        hostProcessId: pluginCommand.hostProcessId,
        pluginIncarnation: pluginCommand.pluginIncarnation,
        sourceDigest,
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
  expect((await queue.history()).entries).toEqual([]);
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
  expectBudget((await queue.read()).jobs[1], true, 0);
  const launched = await queue.drain();
  expect(launched.launches).toHaveLength(1);
  expect(launched.launches[0]?.job).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 1, runningAtMs: now + 1 },
  });
  expect(launched.launches[0]?.job.state.nextRunAtMs).toBeUndefined();
  const stored = (await queue.read()).jobs[1]!;
  expectBudget(stored, false, 1);
  expect(stored.state.nextRunAtMs).toBeUndefined();
  expect((await queue.drain()).launches).toEqual([]);
  await queue.recover();
  const recovered = (await queue.read()).jobs[1]!;
  expectBudget(recovered, false, 1);
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
    restartable("deadline", 0, { hostProcessId: previous, deadlineAtMs: now + 1 }),
    "schedule deadline expired",
  ],
  ["exhausted", restartable("exhausted", 3), "schedule maxRuns exhausted"],
  ["missing-count", { state: launchState() }, "run counter is missing or invalid"],
  ["negative-count", { state: launchState(-1) }, "run counter is missing or invalid"],
  [
    "missing-envelope",
    { pluginCommand: undefined, state: launchState() },
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
  const launch = async (label: string, job: CronStoredJob, hosts: PluginCommandScheduleHost[]) => {
    const queue = await requestCommand(label, job);
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
  const chargedState = { pluginCommandRuns: 2, pluginCommandBinding: binding };
  expect(drained.launches[0]?.job).toMatchObject({
    enabled: true,
    state: chargedState,
    pluginCommand: restartable("rearm").pluginCommand,
  });
  expect((await queue.read()).jobs[0]?.state).toMatchObject(chargedState);
  // A racing claim cannot launch or rebind the running occurrence.
  const racing = requestFor((await queue.read()).jobs[0]!, {
    receiptId: "cron:request:race",
    mode: "force",
  });
  await queue.request([racing]);
  expect(
    (await queue.drain([], 1, false, [{ ...host, pluginIncarnation: "other" }])).launches,
  ).toEqual([]);
  await queue.recover();
  expect((await queue.read()).jobs[0]?.state).toMatchObject(chargedState);

  for (const [label, hosts] of [
    ["no-plugin", []],
    ["other-version", [{ ...host, pluginVersion: "2.0.0" }]],
    ["other-source", [{ ...host, pluginSource: "/plugins/other/index.js" }]],
    ["other-code", [{ ...host, sourceDigest: "digest-b" }]],
    ["command-gone", [{ ...host, commands: ["other-command"] }]],
  ] satisfies Array<[string, PluginCommandScheduleHost[]]>) {
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

it.each([true, false])(
  "retries interrupted occurrences only if unstarted (started=%s)",
  async (started) => {
    const job = {
      ...restartable(started ? "interrupted-started" : "interrupted-unstarted"),
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
    } satisfies CronStoredJob;
    const queue = await requestCommand(job.id, job);
    const first = await queue.drain([], 1, false, [restartedHost]);
    expect(first.launches).toHaveLength(1);
    if (started) {
      // The occurrence passed its delivery fence, so its command may have run.
      await executeOpenClawStateWorker(context, {
        type: "cron.markDeliveryStarted",
        input: { storeKey: queue.storeKey, handle: first.launches[0]!.runReceipt, snapshot: {} },
      });
    }
    await queue.recover();
    const recovered = (await queue.read()).jobs[0]!;
    expect(recovered.state).toMatchObject({ pluginCommandRuns: 1 });
    expect(recovered.state.runningAtMs).toBeUndefined();
    const retryAtMs = recovered.state.startupCatchupAtMs;
    if (started) {
      expect(retryAtMs).toBeUndefined();
      expect(recovered.state.nextRunAtMs).toBeGreaterThanOrEqual(now + 60_000);
      return;
    }
    expect(retryAtMs).toBeGreaterThan(now);
    expect(recovered.state.nextRunAtMs).toBe(retryAtMs);
    const retry = scheduled(queue.storeKey, recovered, retryAtMs!);
    await queue.request([retry, retry], retryAtMs);
    const retried = await queue.drain([], 1, false, [restartedHost]);
    expect(retried.launches).toHaveLength(1);
    expect(retried.launches[0]?.job.state.pluginCommandRuns).toBe(2);
  },
);

it("caps live and restartable peers per parent, excluding stale and retired schedules", async () => {
  const seeded = (
    id: string,
    overrides: Parameters<typeof pluginCommandSchedule>[1],
    bound = true,
    sourceDigest = "digest-a",
  ) => {
    const job = restartable(id, 0, overrides, sourceDigest);
    job.state.nextRunAtMs = now + 30_000;
    if (!bound) {
      delete job.state.pluginCommandBinding;
    }
    return job;
  };
  const seed = [
    seeded("unbound-previous", { hostProcessId: previous }, false),
    seeded("replaced-instance", { pluginIncarnation: "replaced-incarnation" }),
    seeded("other-build", { hostProcessId: previous, pluginVersion: "0.9.0" }),
    seeded("expired", { hostProcessId: previous, deadlineAtMs: now }),
    seeded("other-code", { hostProcessId: previous }, true, "digest-b"),
    ...Array.from({ length: MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT / 2 }, (_, index) =>
      seeded("surviving-" + index, { hostProcessId: previous }),
    ),
  ];
  const queue = await store("stale-cap", seed);
  const add = (id: string) =>
    addCommand(queue.storeKey, commandCreate(id), {
      captured: false,
      pluginCommand: pluginCommandSchedule(now),
      pluginCommandSourceDigest: "digest-a",
    });
  for (let index = 0; index < MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT / 2; index += 1) {
    await expect(add("current-" + index)).resolves.toMatchObject({ outcome: { changed: true } });
  }
  await expect(add("current-overflow")).rejects.toThrow(
    /limited to 8 active jobs per plugin and parent/,
  );
  const stored = await queue.read();
  const enabled = stored.jobs.filter((job) => job.enabled).map((job) => job.id);
  expect(enabled).toHaveLength(seed.length + MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT / 2);
  expect(enabled).not.toContain("current-overflow");
  expect(stored.jobs.find((job) => job.id === "current-0")?.state.pluginCommandBinding).toEqual({
    hostProcessId: currentPluginCommandHostProcessId(),
    pluginIncarnation: "synthetic-plugin-incarnation",
    sourceDigest: "digest-a",
  });
  await addCommand(queue.storeKey, commandCreate("other-parent"), {
    captured: false,
    pluginCommand: pluginCommandSchedule(now, {
      parent: { agentId: "main", sessionKey: "agent:main:other", sessionId: "other" },
    }),
  });
  await queue.update("current-0", { enabled: false });
  await expect(add("replacement")).resolves.toMatchObject({ outcome: { changed: true } });
});

it("keeps a schedule accepted without captured plugin source bound to its Gateway process", async () => {
  const key = fixture.statePath("cron", "no-source-digest.json");
  const [job] = await createCommand(key, commandCreate("no-digest"), {
    captured: false,
    pluginCommand: pluginCommandSchedule(now, { hostProcessId: previous }),
  });
  expect(job!.state.pluginCommandBinding).toBeUndefined();
  const queue = await requestCommand("no-source-digest", {
    ...job!,
    state: { ...job!.state, nextRunAtMs: now },
  });
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
  const duplicate = await addCommand(key, { ...input, id: "ignored-retry-id" }, options);
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
    updateCommand(current.id, { enabled: true }),
    updateCommand(current.id, { payload: { kind: "command", argv: ["echo", "changed"] } }),
  ];
  for (const mutation of rewrites) {
    await expect(mutate(key, mutation)).rejects.toThrow(/plugin command/);
    expect(await queue.read()).toEqual(before);
  }
  await queue.update(current.id, { enabled: false });
  const disabled = (await queue.read()).jobs[0]!;
  expectBudget(disabled, false, 1);
  expect(disabled.pluginCommand).toEqual(before.jobs[0]?.pluginCommand);
  // Disable withdraws unattended authority: a manual force run cannot spend the last attempt.
  const forced = requestFor(disabled, { receiptId: "cron:request:disabled", mode: "force" });
  expect((await queue.request([forced])).rejected).toMatchObject([{ reason: "job-ineligible" }]);
  expect((await queue.read()).jobs[0]?.state.pluginCommandRuns).toBe(1);
  await expect(addCommand(key, input, options)).rejects.toThrow(/cannot be changed or rearmed/);
});

it("rejects caller-authored run accounting on ordinary add and update paths", async () => {
  const key = fixture.statePath("cron", "authored-state.json");
  const input = { ...queueJob("ordinary", now), state: { lastRunAtMs: now, pluginCommandRuns: 0 } };
  await expect(addCommand(key, input, { captured: false })).rejects.toThrow(
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

// Frozen reader: strict envelope, opaque state, process-bound retirement at occurrence time.
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
  const options = {
    captured: false,
    pluginCommand: pluginCommandSchedule(now, { hostProcessId: previous, maxRuns: 3 }),
    pluginCommandSourceDigest: sourceDigest,
  };
  await createCommand(queue.storeKey, commandCreate(label), options, now);
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
async function expectRestartRetired(
  queue: Awaited<ReturnType<typeof acceptedBeforeRestart>>,
  hosts: PluginCommandScheduleHost[] = [host],
  receiptId = "cron:request:after-restart",
) {
  const { requested, drained, job } = await claimAfterRestart(queue, hosts, receiptId);
  expect(job.enabled).toBe(false);
  expect(requested.accepted).toEqual([]);
  expect(drained.launches).toEqual([]);
  expect((await queue.read()).jobs[0]).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 0, pluginCommandBinding: { hostProcessId: previous } },
  });
}

it("an older reader ignores restart continuity and ends the schedule; upgrading never revives it", async () => {
  const queue = await acceptedBeforeRestart("rolled-back");
  const released = await claimWithReleasedReader(queue.storeKey, "rolled-back", true);
  expect(released.retired).toBe(true);
  expect(released.envelope).toMatchObject({ hostProcessId: previous, maxRuns: 3 });
  expect(released.state).toMatchObject({
    pluginCommandRuns: 0,
    pluginCommandBinding: { hostProcessId: previous },
  });
  await expectRestartRetired(queue);
});

it("a schedule an older reader never reached is re-armed after upgrading again", async () => {
  const queue = await acceptedBeforeRestart("untouched");
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
  const bundled = { ...host, sourceDigest: "bundled-build:" + "b".repeat(64) };
  const queue = await acceptedBeforeRestart("bundled-rolled-back", bundled.sourceDigest);
  // A reader without bundled identities cannot match the accepting build.
  const rolledBack = await claimAfterRestart(queue, [], "cron:request:rolled-back");
  expect(rolledBack.drained.launches).toEqual([]);
  expect((await queue.read()).jobs[0]).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 0, pluginCommandBinding: { hostProcessId: previous } },
  });
  await expectRestartRetired(queue, [bundled], "cron:request:bundled-upgraded-again");
});

const jobIds = (runs: CronQueuedRun[]) => runs.map(({ job }) => job.id);
const rejected = (request: QueueRequest, reason = "already-requested") => [
  { jobId: request.jobId, receiptId: request.receiptId, reason },
];
async function scheduledQueue(id: string) {
  const current = queueJob(id, now);
  const queue = await store(id, [current]);
  return { current, queue, request: scheduled(queue.storeKey, current, now) };
}

it("returns durable receipt handles across queued edits", async () => {
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
});

it("holds scheduled requests while paused and activates an explicit request behind them", async () => {
  const jobs = ["timed-paused", "manual-paused"].map((id) => queueJob(id, now));
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

it("rejects a plan made before its definition changed", async () => {
  const { current, queue, request } = await scheduledQueue("changed");
  await queue.update(current.id, { enabled: false });
  expect((await queue.request([request])).rejected).toEqual(rejected(request, "job-ineligible"));
});

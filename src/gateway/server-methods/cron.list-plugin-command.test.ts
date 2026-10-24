import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { CronJobSchema } from "../../../packages/gateway-protocol/src/schema/cron.js";
import { pluginCommandSchedule } from "../../cron/plugin-command-schedule.test-support.js";
import { PLUGIN_COMMAND_SCHEDULE_MESSAGE } from "../../cron/plugin-command-schedule.types.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "../../cron/service.test-harness.js";
import type { CronStoredJob } from "../../cron/types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import { cronHandlers } from "./cron.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-list-plugin-command-",
  fakeTimers: false,
});
const nowMs = Date.parse("2026-10-22T12:00:00.000Z");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

function storedJob(id: string, overrides: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "every", everyMs: 600_000, anchorMs: nowMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Summarize the inbox." },
    delivery: { mode: "none" },
    state: { nextRunAtMs: nowMs + 600_000 },
    ...overrides,
  };
}

/** Persists rows through the real SQLite store and lists them through the Gateway handler. */
async function listThroughGateway(jobs: CronStoredJob[], params: Record<string, unknown>) {
  const store = await makeStorePath();
  cleanups.push(() => store.cleanup());
  await writeCronStoreSnapshot({ storePath: store.storePath, jobs });
  const { cron } = createCronServiceWithStateForTest({
    scheduler: createTestGatewayScheduler(createGatewaySchedulerClock(nowMs).clock),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await cron.start();
  cleanups.push(() => cron.stop());
  const context = {
    cron,
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestContext;
  const respond = vi.fn<RespondFn>();
  await cronHandlers["cron.list"]!({
    req: { type: "req", id: "plugin-command-list", method: "cron.list", params },
    params,
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledOnce();
  const [ok, payload, error] = respond.mock.calls[0]!;
  expect({ ok, error }).toEqual({ ok: true, error: undefined });
  const frame = serializeGatewayFrame({
    type: "res",
    id: "plugin-command-list",
    ok: true,
    payload,
  });
  const wire = JSON.parse(frame.toString()).payload as { jobs: Array<Record<string, unknown>> };
  return new Map(wire.jobs.map((job) => [job.id as string, job]));
}

it("reports a stored plugin-command schedule's kind while keeping its compatible payload", async () => {
  const schedule = pluginCommandSchedule(nowMs, { deadlineAtMs: nowMs + 3_600_000 });
  const rows = await listThroughGateway(
    [
      storedJob("ordinary"),
      storedJob("scheduled-command", {
        sessionTarget: "session:agent:main:parent",
        payload: {
          kind: "agentTurn",
          message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
          toolsAllow: ["sessions_spawn", "agents_wait"],
        },
        pluginCommand: schedule,
        state: { nextRunAtMs: nowMs + 600_000, pluginCommandRuns: 0 },
      }),
    ],
    { includeDisabled: true },
  );

  const command = rows.get("scheduled-command");
  expect(command?.payloadSource).toEqual({
    kind: "pluginCommand",
    pluginId: "watcher",
    command: "watcher-resume",
  });
  // Existing readers still receive the reserved agentTurn row they already understand.
  expect(command?.payload).toEqual({
    kind: "agentTurn",
    message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
    toolsAllow: ["sessions_spawn", "agents_wait"],
  });
  // The descriptor names the kind only; the private envelope and requester arguments stay private.
  const serialized = JSON.stringify(command);
  for (const secret of [
    schedule.args!,
    schedule.hostProcessId,
    schedule.pluginIncarnation,
    schedule.pluginSource,
    schedule.sourceRunId,
    "synthetic-operator",
  ]) {
    expect(serialized).not.toContain(secret);
  }
  expect(command?.state).not.toHaveProperty("pluginCommandRuns");

  const ordinary = rows.get("ordinary");
  expect(ordinary).not.toHaveProperty("payloadSource");
  expect(ordinary?.payload).toEqual({ kind: "agentTurn", message: "Summarize the inbox." });

  // Both rows satisfy the published job contract without the list-only effective agent.
  for (const row of [command, ordinary]) {
    const { effectiveAgentId: _effectiveAgentId, ...job } = row!;
    expect([...Value.Errors(CronJobSchema, job)]).toEqual([]);
  }
});

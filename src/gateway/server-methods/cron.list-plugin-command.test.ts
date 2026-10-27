import { Value } from "typebox/value";
import { expect, it, onTestFinished, vi } from "vitest";
import { CronJobSchema } from "../../../packages/gateway-protocol/src/schema/cron.js";
import { pluginCommandSchedule } from "../../cron/plugin-command-schedule.test-support.js";
import { PLUGIN_COMMAND_SCHEDULE_MESSAGE } from "../../cron/plugin-command-schedule.types.js";
import { createCronStoreHarness, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import type { CronStoredJob } from "../../cron/types.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import { callCron, createReadService } from "./cron-read.test-support.js";
import { createCronJob } from "./cron.validation.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-list-plugin-command-",
});
const nowMs = Date.parse("2026-10-22T12:00:00.000Z");

function storedJob(id: string, overrides: Partial<CronStoredJob> = {}): CronStoredJob {
  return createCronJob({
    id,
    payload: { kind: "agentTurn", message: "Summarize the inbox." },
    ...overrides,
  });
}

async function listThroughGateway(jobs: CronStoredJob[], params: Record<string, unknown>) {
  const store = await makeStorePath();
  await writeCronStoreSnapshot({ storePath: store.storePath, jobs });
  const cron = createReadService({
    storePath: store.storePath,
    cronEnabled: true,
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  onTestFinished(() => cron.stop());
  const context = {
    cron,
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestContext;
  const respond = await callCron(context, "cron.list", params);
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

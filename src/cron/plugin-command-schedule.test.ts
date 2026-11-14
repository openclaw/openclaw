import { expect, it } from "vitest";
import { getInvalidPersistedCronJobReason as invalidReason } from "./persisted-shape.js";
import {
  currentPluginCommandHostProcessId,
  getPluginCommandRunBudgetError,
} from "./plugin-command-schedule.js";
import { pluginCommandSchedule } from "./plugin-command-schedule.test-support.js";
import { PLUGIN_COMMAND_SCHEDULE_MESSAGE } from "./plugin-command-schedule.types.js";
import { toPublicCronJob } from "./public-job.js";
import { stripJobRuntimeFields } from "./store/job-config-codec.js";
import { projectCronJobThroughStorageCodec, rowToCronJob } from "./store/row-codec.js";
import { queueJob } from "./store/run-queue.test-support.js";
import type { CronStoredJob } from "./types.js";

const now = 1_800_000_000_000;
const reservedPayload = {
  kind: "agentTurn" as const,
  message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
  toolsAllow: ["sessions_spawn", "agents_wait"],
};
const commandJob = (): CronStoredJob => ({
  ...queueJob("private-command", now),
  payload: { ...reservedPayload, toolsAllow: [...reservedPayload.toolsAllow] },
  pluginCommand: pluginCommandSchedule(now),
  state: { nextRunAtMs: now, pluginCommandRuns: 1 },
});
const row = {
  job_id: "private-command",
  state_json: "{}",
  runtime_updated_at_ms: now,
  updated_at: now,
};

it("round-trips private invocation facts and foreign JSON without exposing them publicly", () => {
  const stored = { ...commandJob(), foreignExtension: { retained: true } };
  const restored = projectCronJobThroughStorageCodec(stored);
  expect(restored).toMatchObject({
    payload: reservedPayload,
    pluginCommand: stored.pluginCommand,
    state: { nextRunAtMs: now, pluginCommandRuns: 1 },
    foreignExtension: { retained: true },
  });
  const publicJob = toPublicCronJob(restored);
  expect(publicJob).not.toHaveProperty("pluginCommand");
  expect(publicJob.state).not.toHaveProperty("pluginCommandRuns");
});

const malformed = [
  { version: 2 },
  { pluginSource: " " },
  { command: "/watcher-resume" },
  { command: "Watcher-resume" },
  { parent: { agentId: "main", sessionKey: "agent:main:parent" } },
  { operatorSource: { kind: "unavailable" } },
  { operatorSource: { kind: "gateway", snapshot: {} } },
  { toolsAllow: ["sessions_spawn"] },
  { toolsAllow: ["sessions_spawn", "agents_wait", "*"] },
  { deadlineAtMs: 0 },
  { deadlineAtMs: 8_640_000_000_000_001 },
  { maxRuns: 0 },
  { maxRuns: 1.5 },
  { maxRuns: 101 },
  { args: "界".repeat(24_000) },
  { authority: "operator.admin" },
];
it.each(malformed)("quarantines malformed invocation facts: %j", (overrides) => {
  const envelope = { ...pluginCommandSchedule(now), ...overrides };
  expect(
    invalidReason({
      ...queueJob("malformed-command", now),
      pluginCommand: envelope,
    }),
  ).toBe("invalid-plugin-command");
});

it("stores no runnable legacy payload, so a reader without the envelope quarantines it", () => {
  const definition = structuredClone(stripJobRuntimeFields(commandJob()));
  expect(definition.payload).toEqual({
    kind: "pluginCommand",
    toolsAllow: reservedPayload.toolsAllow,
  });
  expect(JSON.stringify(definition)).not.toContain(PLUGIN_COMMAND_SCHEDULE_MESSAGE);
  expect(invalidReason(definition)).toBeNull();
  // A host that predates command schedules ignores `pluginCommand` and sees an unknown kind.
  const { pluginCommand: _ignored, ...withoutEnvelope } = definition;
  expect(invalidReason(withoutEnvelope)).toBe("invalid-payload");
  expect(rowToCronJob(row, withoutEnvelope)).toBeNull();
  // A stored agentTurn copy with the envelope (the form older candidates wrote) is not run.
  expect(rowToCronJob(row, { ...definition, payload: reservedPayload })).toBeNull();
  expect(rowToCronJob(row, definition)).toMatchObject({ payload: reservedPayload });
});

it("refuses to persist an envelope paired with any non-reserved payload", () => {
  expect(() =>
    stripJobRuntimeFields({ ...commandJob(), payload: { kind: "command", argv: ["echo"] } }),
  ).toThrow(/without its reserved payload/);
});

it("requires a known Gateway process before any charge", () => {
  const job = commandJob();
  const host = currentPluginCommandHostProcessId();
  expect(getPluginCommandRunBudgetError(job, now, host)).toBeUndefined();
  // A drain that does not name its Gateway process cannot prove the bound instance survives.
  expect(getPluginCommandRunBudgetError(job, now, undefined)).toBe(
    "cron: plugin command schedule ended with its Gateway process",
  );
});

import { describe, expect, it } from "vitest";
import { pluginCommandSchedule } from "../cron/plugin-command-schedule.test-support.js";
import { PLUGIN_COMMAND_SCHEDULE_MESSAGE } from "../cron/plugin-command-schedule.types.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../cron/scheduled-occurrence.test-support.js";
import type { CronStoredJob } from "../cron/types.js";
import { registerPluginCommandInRegistry } from "../plugins/command-registration.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstanceIncarnation } from "../plugins/plugin-instance-scope.js";
import { createTestInstance } from "../plugins/plugin-instance.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  adoptPluginRegistryRecords,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import {
  assertPluginCommandScheduleRegistry,
  readPluginCommandScheduledJob,
  runPluginCommandScheduledTurn,
} from "./plugin-command-scheduled-run.js";

const now = 1_800_000_000_000;

function scheduledJob(): CronStoredJob {
  const pluginCommand = pluginCommandSchedule(now);
  return {
    id: "scheduled-command",
    name: "Scheduled command",
    agentId: "main",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "session:agent:main:parent",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
      toolsAllow: [...pluginCommand.toolsAllow],
    },
    delivery: { mode: "none" },
    state: {},
    sourceConversation: {
      sessionKey: pluginCommand.parent.sessionKey,
      sessionId: pluginCommand.parent.sessionId,
    },
    pluginCommand,
  };
}

function boundJob() {
  const job = scheduledJob();
  if (job.payload.kind !== "agentTurn" || !job.sourceConversation) {
    throw new Error("fixture is not a bound agent turn");
  }
  return { ...job, payload: job.payload, sourceConversation: job.sourceConversation };
}

const runScheduled = (job: CronStoredJob, message = PLUGIN_COMMAND_SCHEDULE_MESSAGE) =>
  runPluginCommandScheduledTurn({
    request: { occurrence: TEST_SCHEDULED_OCCURRENCE, job, message, deliveryAttemptFence: null },
    cfg: {},
    agentId: "main",
  });

// These tests consume persisted DATA only. No operator authority is manufactured, no DB or
// scheduler is started, and the synthetic storage snapshot is never passed to restoration.
describe("scheduled plugin command reservation", () => {
  it("leaves ordinary cron prompts to their existing runner", async () => {
    const job = scheduledJob();
    delete job.pluginCommand;
    job.payload = { kind: "agentTurn", message: "ordinary prompt" };
    expect(readPluginCommandScheduledJob(job)).toBeUndefined();
    await expect(runScheduled(job, "ordinary prompt")).resolves.toBeUndefined();
  });

  it("does not forward a sentinel whose private envelope was lost into the LLM path", async () => {
    const job = scheduledJob();
    delete job.pluginCommand;
    await expect(runScheduled(job)).resolves.toMatchObject({
      status: "error",
      executionStarted: false,
      delivered: false,
      deliveryAttempted: false,
      error: expect.stringContaining("missing its private envelope"),
    });
  });

  it("accepts a private exact parent and a restrict-only native tool cap", () => {
    const job = scheduledJob();
    expect(readPluginCommandScheduledJob(job)).toEqual(job.pluginCommand);
    if (job.payload.kind !== "agentTurn" || !job.pluginCommand) {
      throw new Error("fixture is not a scheduled command");
    }
    job.pluginCommand.toolsAllow.push("read");
    expect(readPluginCommandScheduledJob(job)).toEqual(job.pluginCommand);
  });

  const mutations: [string, (job: ReturnType<typeof boundJob>) => void][] = [
    [
      "changed prompt",
      (job) => {
        job.payload = {
          kind: "agentTurn",
          message: "please run command",
          toolsAllow: ["sessions_spawn", "agents_wait"],
        };
      },
    ],
    ["other agent", (job) => (job.agentId = "other")],
    ["other parent", (job) => (job.sessionTarget = "session:agent:main:other")],
    ["reset parent", (job) => (job.sourceConversation.sessionId = "replacement")],
    [
      "changed parent lifecycle",
      (job) => (job.sourceConversation.lifecycleRevision = "replacement"),
    ],
    ["announcement routing", (job) => (job.delivery = { mode: "announce" })],
    [
      "hidden external failure routing",
      (job) => (job.delivery = { mode: "none", channel: "telegram" }),
    ],
    [
      "expanded native cap",
      (job) => (job.payload.toolsAllow = ["sessions_spawn", "agents_wait", "exec"]),
    ],
    ["lost collect permission", (job) => (job.payload.toolsAllow = ["sessions_spawn"])],
  ];
  it.each(mutations)(
    "refuses %s before authority or transcript admission",
    async (_name, mutate) => {
      const job = boundJob();
      mutate(job);
      expect(() => readPluginCommandScheduledJob(job)).toThrow("does not match");
      // The refusal must come from the job binding, not the missing live occurrence below.
      await expect(runScheduled(job)).resolves.toMatchObject({
        status: "error",
        executionStarted: false,
        error: expect.stringContaining("does not match its bound conversation"),
      });
    },
  );

  it("requires the actual native occurrence, rather than admitting a detached callback", async () => {
    await expect(runScheduled(scheduledJob())).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("live Gateway occurrence"),
      executionStarted: false,
    });
  });
});

function registeredSchedule() {
  const schedule = pluginCommandSchedule(now);
  const registry = createEmptyPluginRegistry();
  const plugin = createPluginRecord({
    id: schedule.pluginId,
    source: schedule.pluginSource,
    rootDir: schedule.pluginRoot,
    version: schedule.pluginVersion,
    origin: "config",
    enabled: true,
    configSchema: true,
    contracts: {
      commandRuntimeCapabilities: ["subagents"],
      sessionScheduledTurns: ["requester-command"],
    },
  });
  plugin.status = "loaded";
  registry.plugins.push(plugin);
  const instance = createTestInstance(plugin.id, { record: plugin, registry });
  const incarnation = getPluginInstanceIncarnation(plugin);
  if (!incarnation) {
    throw new Error("managed fixture incarnation missing");
  }
  schedule.pluginIncarnation = incarnation;
  const registration = registerPluginCommandInRegistry(
    registry,
    plugin.id,
    {
      name: schedule.command,
      description: "Resume an existing workflow",
      requireAuth: true,
      runtimeCapabilities: ["subagents"],
      acceptsArgs: true,
      handler: () => ({ text: "not executed" }),
    },
    { pluginRoot: plugin.rootDir },
    ["subagents"],
  );
  expect(registration).toEqual({ ok: true });
  expect(() => assertPluginCommandScheduleRegistry(registry, schedule)).not.toThrow();
  return { registry, schedule, plugin, instance };
}

describe("scheduled plugin command loaded-owner checks", () => {
  it("rejects a replacement with identical metadata and a fresh managed owner", () => {
    const original = registeredSchedule();
    const replacement = registeredSchedule();
    // A current registry serving another live instance ends the schedule for good.
    expect(() =>
      assertPluginCommandScheduleRegistry(replacement.registry, original.schedule),
    ).toThrow("original plugin instance was replaced");
  });

  it("preserves the binding when the exact managed instance is adopted", () => {
    const { registry, schedule, plugin } = registeredSchedule();
    const adopted = {
      ...createEmptyPluginRegistry(),
      plugins: [plugin],
      commands: registry.commands,
    };
    adoptPluginRegistryRecords(adopted);
    markPluginRegistryRetired(registry);
    expect(() => assertPluginCommandScheduleRegistry(adopted, schedule)).not.toThrow();
  });

  it("requires a re-armed instance to still run the code the schedule accepted", () => {
    const { registry, schedule, instance } = registeredSchedule();
    instance.sourceDigest = "accepted-digest";
    const binding = {
      pluginIncarnation: schedule.pluginIncarnation,
      sourceDigest: "accepted-digest",
    };
    expect(() => assertPluginCommandScheduleRegistry(registry, schedule, binding)).not.toThrow();
    expect(() =>
      assertPluginCommandScheduleRegistry(registry, schedule, {
        ...binding,
        sourceDigest: "other-digest",
      }),
    ).toThrow("original loaded plugin");
    // An instance without captured source can never serve a restartable binding.
    instance.sourceDigest = undefined;
    expect(() => assertPluginCommandScheduleRegistry(registry, schedule, binding)).toThrow(
      "original loaded plugin",
    );
  });

  type Fixture = ReturnType<typeof registeredSchedule>;
  const changes: [string, (fixture: Fixture) => unknown][] = [
    ["source", ({ plugin }) => (plugin.source = "/replacement/index.js")],
    ["root", ({ plugin }) => (plugin.rootDir = "/replacement")],
    ["version", ({ plugin }) => (plugin.version = "2.0.0")],
    ["contract", ({ plugin }) => (plugin.contracts = {})],
    ["disabled", ({ plugin }) => (plugin.enabled = false)],
    ["unloaded", ({ plugin }) => (plugin.status = "error")],
    ["foreign-command", ({ registry }) => (registry.commands[0]!.pluginId = "other")],
    ["unauthenticated", ({ registry }) => (registry.commands[0]!.command.requireAuth = false)],
    ["no-subagents", ({ registry }) => (registry.commands[0]!.command.runtimeCapabilities = [])],
    ["disposed", ({ instance }) => instance.dispose()],
    ["ownerless metadata", ({ registry, plugin }) => (registry.plugins = [{ ...plugin }])],
    ["retired registry", ({ registry }) => markPluginRegistryRetired(registry)],
  ];
  it.each(changes)("refuses %s changes in the actual registry", async (_change, mutate) => {
    const fixture = registeredSchedule();
    await mutate(fixture);
    expect(() => assertPluginCommandScheduleRegistry(fixture.registry, fixture.schedule)).toThrow(
      "original loaded plugin",
    );
  });
});

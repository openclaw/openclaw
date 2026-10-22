import { describe, expect, it } from "vitest";
import { pluginCommandSchedule } from "../cron/plugin-command-schedule.test-support.js";
import { PLUGIN_COMMAND_SCHEDULE_MESSAGE } from "../cron/plugin-command-schedule.types.js";
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

// These tests consume persisted DATA only. No operator authority is manufactured, no DB or
// scheduler is started, and the synthetic storage snapshot is never passed to restoration.
describe("scheduled plugin command reservation", () => {
  it("leaves ordinary cron prompts to their existing runner", async () => {
    const job = scheduledJob();
    delete job.pluginCommand;
    job.payload = { kind: "agentTurn", message: "ordinary prompt" };
    expect(readPluginCommandScheduledJob(job)).toBeUndefined();
    await expect(
      runPluginCommandScheduledTurn({
        request: { job, message: "ordinary prompt", deliveryAttemptFence: null },
        cfg: {},
        agentId: "main",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not forward a sentinel whose private envelope was lost into the LLM path", async () => {
    const job = scheduledJob();
    delete job.pluginCommand;
    await expect(
      runPluginCommandScheduledTurn({
        request: { job, message: PLUGIN_COMMAND_SCHEDULE_MESSAGE, deliveryAttemptFence: null },
        cfg: {},
        agentId: "main",
      }),
    ).resolves.toMatchObject({
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

  const mutations: [string, (job: CronStoredJob) => void][] = [
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
    [
      "other agent",
      (job) => {
        job.agentId = "other";
      },
    ],
    [
      "other parent",
      (job) => {
        job.sessionTarget = "session:agent:main:other";
      },
    ],
    [
      "reset parent",
      (job) => {
        if (job.sourceConversation) {
          job.sourceConversation.sessionId = "replacement";
        }
      },
    ],
    [
      "changed parent lifecycle",
      (job) => {
        if (job.sourceConversation) {
          job.sourceConversation.lifecycleRevision = "replacement";
        }
      },
    ],
    [
      "announcement routing",
      (job) => {
        job.delivery = { mode: "announce" };
      },
    ],
    [
      "hidden external failure routing",
      (job) => {
        job.delivery = { mode: "none", channel: "telegram" };
      },
    ],
    [
      "expanded native cap",
      (job) => {
        if (job.payload.kind === "agentTurn") {
          job.payload.toolsAllow = ["sessions_spawn", "agents_wait", "exec"];
        }
      },
    ],
    [
      "lost collect permission",
      (job) => {
        if (job.payload.kind === "agentTurn") {
          job.payload.toolsAllow = ["sessions_spawn"];
        }
      },
    ],
  ];
  it.each(mutations)(
    "refuses %s before authority or transcript admission",
    async (_name, mutate) => {
      const job = scheduledJob();
      mutate(job);
      expect(() => readPluginCommandScheduledJob(job)).toThrow("does not match");
      // The refusal must come from the job binding, not the missing live occurrence below.
      await expect(
        runPluginCommandScheduledTurn({
          request: { job, message: PLUGIN_COMMAND_SCHEDULE_MESSAGE, deliveryAttemptFence: null },
          cfg: {},
          agentId: "main",
        }),
      ).resolves.toMatchObject({
        status: "error",
        executionStarted: false,
        error: expect.stringContaining("does not match its bound conversation"),
      });
    },
  );

  it("requires the actual native occurrence, rather than admitting a detached callback", async () => {
    const job = scheduledJob();
    await expect(
      runPluginCommandScheduledTurn({
        request: { job, message: PLUGIN_COMMAND_SCHEDULE_MESSAGE, deliveryAttemptFence: null },
        cfg: {},
        agentId: "main",
      }),
    ).resolves.toMatchObject({
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

  it("rejects a disposed instance even while its metadata remains loaded", async () => {
    const { registry, schedule, instance } = registeredSchedule();
    await instance.dispose();
    expect(() => assertPluginCommandScheduleRegistry(registry, schedule)).toThrow(
      "original loaded plugin",
    );
  });

  it("rejects an ownerless metadata copy rather than manufacturing an incarnation", () => {
    const { registry, schedule, plugin } = registeredSchedule();
    registry.plugins = [{ ...plugin }];
    expect(() => assertPluginCommandScheduleRegistry(registry, schedule)).toThrow(
      "original loaded plugin",
    );
  });

  it("uses real registered canonical ownership without requiring scheduling capability on the target", () => {
    const { registry, schedule } = registeredSchedule();
    expect(() => assertPluginCommandScheduleRegistry(registry, schedule)).not.toThrow();
  });

  it.each([
    "source",
    "root",
    "version",
    "contract",
    "disabled",
    "unloaded",
    "foreign-command",
    "unauthenticated",
    "no-subagents",
  ])("refuses %s changes in the actual registry", (change) => {
    const { registry, schedule, plugin } = registeredSchedule();
    const registered = registry.commands[0];
    if (!registered) {
      throw new Error("registered command missing");
    }
    switch (change) {
      case "source":
        plugin.source = "/replacement/index.js";
        break;
      case "root":
        plugin.rootDir = "/replacement";
        break;
      case "version":
        plugin.version = "2.0.0";
        break;
      case "contract":
        plugin.contracts = {};
        break;
      case "disabled":
        plugin.enabled = false;
        break;
      case "unloaded":
        plugin.status = "error";
        break;
      case "foreign-command":
        registered.pluginId = "other";
        break;
      case "unauthenticated":
        registered.command.requireAuth = false;
        break;
      case "no-subagents":
        registered.command.runtimeCapabilities = [];
        break;
    }
    expect(() => assertPluginCommandScheduleRegistry(registry, schedule)).toThrow(
      "original loaded plugin",
    );
  });

  it("refuses an old retired registry even if its records and registration still match", () => {
    const { registry, schedule } = registeredSchedule();
    markPluginRegistryRetired(registry);
    expect(() => assertPluginCommandScheduleRegistry(registry, schedule)).toThrow(
      "original loaded plugin",
    );
  });
});

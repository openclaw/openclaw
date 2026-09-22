// Covers heartbeat model override routing.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey, resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  heartbeatTestConfig,
  seedSessionStore,
  type HeartbeatReplySpy,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([]),
  deliverOutboundPayloadsInternal: vi.fn().mockResolvedValue([]),
}));

type SeedSessionInput = {
  lastChannel: string;
  lastTo: string;
  updatedAt?: number;
};
type AgentDefaultsConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type HeartbeatConfig = NonNullable<AgentDefaultsConfig["heartbeat"]>;

function expectReplyOptions(options: unknown, expected: Record<string, unknown>) {
  if (!options || typeof options !== "object") {
    throw new Error("expected reply options");
  }
  const actual = options as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function firstReplyCall(replySpy: HeartbeatReplySpy) {
  return replySpy.mock.calls[0] ?? [];
}

async function withHeartbeatFixture(
  run: (ctx: {
    tmpDir: string;
    storePath: string;
    replySpy: HeartbeatReplySpy;
    seedSession: (sessionKey: string, input: SeedSessionInput) => Promise<void>;
  }) => Promise<unknown>,
): Promise<unknown> {
  return withTempHeartbeatSandbox(
    async ({ tmpDir, storePath, replySpy }) => {
      const seedSession = async (sessionKey: string, input: SeedSessionInput) => {
        await seedSessionStore(storePath, sessionKey, {
          updatedAt: input.updatedAt,
          lastChannel: input.lastChannel,
          lastProvider: input.lastChannel,
          lastTo: input.lastTo,
        });
      };
      return run({ tmpDir, storePath, replySpy, seedSession });
    },
    { prefix: "openclaw-hb-model-" },
  );
}

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – heartbeat model override", () => {
  async function runHeartbeatWithSeed(params: {
    seedSession: (sessionKey: string, input: SeedSessionInput) => Promise<void>;
    cfg: OpenClawConfig;
    sessionKey: string;
    replySpy: HeartbeatReplySpy;
    agentId?: string;
    heartbeat?: Parameters<typeof runHeartbeatOnce>[0]["heartbeat"];
    source?: Parameters<typeof runHeartbeatOnce>[0]["source"];
  }) {
    await params.seedSession(params.sessionKey, { lastChannel: "whatsapp", lastTo: "+1555" });

    params.replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

    await runHeartbeatOnce({
      cfg: params.cfg,
      agentId: params.agentId,
      heartbeat: params.heartbeat,
      source: params.source,
      deps: {
        getReplyFromConfig: params.replySpy,
        getQueueSize: () => 0,
        nowMs: () => 0,
      },
    });

    expect(params.replySpy).toHaveBeenCalledTimes(1);
    const [ctx, opts] = firstReplyCall(params.replySpy);
    return {
      ctx,
      opts,
      replySpy: params.replySpy,
    };
  }

  async function runDefaultsHeartbeat(params: {
    every?: string;
    defaultTimeoutSeconds?: number;
    model?: string;
    timeoutSeconds?: number;
    lightContext?: boolean;
    isolatedSession?: boolean;
    heartbeat?: Parameters<typeof runHeartbeatOnce>[0]["heartbeat"];
    source?: Parameters<typeof runHeartbeatOnce>[0]["source"];
  }) {
    return withHeartbeatFixture(async ({ tmpDir, storePath, replySpy, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            timeoutSeconds: params.defaultTimeoutSeconds,
            heartbeat: {
              every: params.every ?? "5m",
              target: "whatsapp",
              model: params.model,
              timeoutSeconds: params.timeoutSeconds,
              lightContext: params.lightContext,
              isolatedSession: params.isolatedSession,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const result = await runHeartbeatWithSeed({
        seedSession,
        cfg,
        sessionKey,
        replySpy,
        heartbeat: params.heartbeat,
        source: params.source,
      });
      return result.opts;
    });
  }

  async function expectPerAgentHeartbeatOverride(params: {
    defaultsHeartbeat: Partial<HeartbeatConfig>;
    expectedOptions: Record<string, unknown>;
    heartbeat: Partial<HeartbeatConfig>;
  }): Promise<void> {
    await withHeartbeatFixture(async ({ tmpDir, storePath, replySpy, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: {
              every: "30m",
              ...params.defaultsHeartbeat,
            },
          },
          list: [
            { id: "main", default: true },
            {
              id: "ops",
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "whatsapp",
                ...params.heartbeat,
              },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "ops" });
      const result = await runHeartbeatWithSeed({
        seedSession,
        cfg,
        agentId: "ops",
        sessionKey,
        replySpy,
      });

      expect(result.replySpy).toHaveBeenCalledTimes(1);
      const [ctx, opts, passedConfig] = firstReplyCall(result.replySpy);
      if (!ctx || typeof ctx !== "object") {
        throw new Error("expected heartbeat reply context");
      }
      expectReplyOptions(opts, {
        isHeartbeat: true,
        ...params.expectedOptions,
      });
      expect(passedConfig).toBe(cfg);
    });
  }

  it("passes heartbeatModelOverride from defaults heartbeat config", async () => {
    const replyOpts = await runDefaultsHeartbeat({ model: "ollama/llama3.2:1b" });
    expectReplyOptions(replyOpts, {
      isHeartbeat: true,
      heartbeatModelOverride: "ollama/llama3.2:1b",
    });
  });

  it("passes heartbeat timeoutSeconds as a reply-run timeout override", async () => {
    const replyOpts = await runDefaultsHeartbeat({ timeoutSeconds: 45 });
    expectReplyOptions(replyOpts, {
      isHeartbeat: true,
      timeoutOverrideSeconds: 45,
    });
  });

  it.each<{
    name: string;
    source?: "exec-event" | "hook" | "cron" | "background-task" | "background-task-blocked";
    eventText?: string;
    contextKey?: string;
    isolatedEvent?: boolean;
    heartbeat?: Partial<HeartbeatConfig>;
    defaultTimeoutSeconds?: number;
    scheduledTasks?: boolean;
    expectedTimeoutMs: number;
  }>([
    { name: "ordinary agent default", expectedTimeoutMs: 48 * 60 * 60_000 },
    {
      name: "ordinary agent default despite an explicit heartbeat limit",
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: 48 * 60 * 60_000,
    },
    {
      name: "ordinary agent default for a hook-carried completion",
      source: "hook",
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: 48 * 60 * 60_000,
    },
    {
      name: "ordinary agent default with recurring heartbeat disabled",
      heartbeat: { every: "0m" },
      expectedTimeoutMs: 48 * 60 * 60_000,
    },
    {
      name: "configured agent limit",
      defaultTimeoutSeconds: 900,
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: 900_000,
    },
    {
      name: "unlimited agent limit",
      defaultTimeoutSeconds: 0,
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: MAX_TIMER_TIMEOUT_MS,
    },
    {
      name: "heartbeat limit when scheduled tasks take precedence",
      scheduledTasks: true,
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: 45_000,
    },
    {
      name: "ordinary agent budget for background task review",
      source: "background-task",
      contextKey: "task:review",
      eventText: "Delegated task completed. Review and verify the result.",
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: 48 * 60 * 60_000,
    },
    {
      name: "configured agent budget for a blocked task continuation",
      source: "background-task-blocked",
      contextKey: "task:review:blocked-followup",
      eventText: "Delegated task is blocked. Continue the remaining work.",
      defaultTimeoutSeconds: 900,
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: 900_000,
    },
    {
      name: "unlimited agent budget for a coalesced task review",
      source: "hook",
      contextKey: "task:review",
      eventText: "Delegated task completed. Review and verify the result.",
      defaultTimeoutSeconds: 0,
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: MAX_TIMER_TIMEOUT_MS,
    },
    {
      name: "agent budget when a scheduled turn admits a task review",
      source: "background-task",
      contextKey: "task:review",
      eventText: "Delegated task completed. Review and verify the result.",
      scheduledTasks: true,
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: 48 * 60 * 60_000,
    },
    {
      name: "heartbeat budget for an unconsumed base-session task",
      source: "background-task",
      contextKey: "task:review",
      eventText: "Delegated task completed. Review and verify the result.",
      heartbeat: { timeoutSeconds: 45, isolatedSession: true },
      expectedTimeoutMs: 45_000,
    },
    {
      name: "ordinary agent budget for a task on the isolated execution queue",
      source: "background-task",
      contextKey: "task:review",
      eventText: "Delegated task completed. Review and verify the result.",
      isolatedEvent: true,
      heartbeat: { timeoutSeconds: 45, isolatedSession: true },
      expectedTimeoutMs: 48 * 60 * 60_000,
    },
    {
      name: "ordinary agent budget for a cron-carried task review",
      source: "cron",
      contextKey: "task:review",
      eventText: "Delegated task completed. Review and verify the result.",
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: 48 * 60 * 60_000,
    },
    {
      name: "heartbeat budget when a cron-carried review is deferred behind scheduled tasks",
      source: "cron",
      contextKey: "task:review",
      eventText: "Delegated task completed. Review and verify the result.",
      scheduledTasks: true,
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: 45_000,
    },
    {
      name: "heartbeat budget for an unrelated notification",
      source: "background-task",
      contextKey: "notification:status",
      eventText: "Service status changed.",
      heartbeat: { timeoutSeconds: 45 },
      expectedTimeoutMs: 45_000,
    },
  ])("uses the $name with a pending event", async (testCase) => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, replySpy, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            timeoutSeconds: testCase.defaultTimeoutSeconds,
            heartbeat: {
              every: "30m",
              target: "whatsapp",
              ...testCase.heartbeat,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = `${resolveMainSessionKey(cfg)}${testCase.isolatedEvent ? ":heartbeat" : ""}`;
      await seedSession(sessionKey, { lastChannel: "whatsapp", lastTo: "+1555" });
      enqueueSystemEvent(
        testCase.eventText ?? "Exec finished (gateway id=build, code 0)\nBuild passed",
        { sessionKey, contextKey: testCase.contextKey },
      );
      replySpy.mockResolvedValue({ text: "Build passed; continuing verification." });
      const source = testCase.source ?? "exec-event";

      await runHeartbeatOnce({
        cfg,
        sessionKey,
        source,
        intent: source === "exec-event" ? "event" : "immediate",
        reason: source === "hook" ? "hook:wake" : source,
        tasks: testCase.scheduledTasks
          ? [{ jobId: "monitor", name: "status", prompt: "Check service status" }]
          : undefined,
        deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0 },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const [ctx, opts, passedConfig] = firstReplyCall(replySpy);
      expect(ctx?.InternalTurnSource).toBe(
        testCase.scheduledTasks
          ? "heartbeat"
          : source === "cron"
            ? "cron"
            : testCase.eventText
              ? "heartbeat"
              : "exec",
      );
      expect(
        resolveAgentTimeoutMs({ cfg: passedConfig, overrideSeconds: opts?.timeoutOverrideSeconds }),
      ).toBe(testCase.expectedTimeoutMs);
    });
  });

  it("keeps configured run options when a direct wake overrides only the destination", async () => {
    const replyOpts = await runDefaultsHeartbeat({
      timeoutSeconds: 45,
      lightContext: true,
      heartbeat: { target: "last" },
      source: "manual",
    });
    expectReplyOptions(replyOpts, {
      isHeartbeat: true,
      timeoutOverrideSeconds: 45,
      bootstrapContextMode: "lightweight",
    });
  });

  it("uses heartbeat cadence as the default reply-run timeout override", async () => {
    const replyOpts = await runDefaultsHeartbeat({});
    expectReplyOptions(replyOpts, {
      isHeartbeat: true,
      timeoutOverrideSeconds: 300,
    });
  });

  it("caps the default heartbeat reply-run timeout override", async () => {
    const replyOpts = await runDefaultsHeartbeat({ every: "30m" });
    expectReplyOptions(replyOpts, {
      isHeartbeat: true,
      timeoutOverrideSeconds: 600,
    });
  });

  it.each([0, 60])(
    "preserves explicit default agent timeout %d for heartbeat runs",
    async (defaultTimeoutSeconds) => {
      const replyOpts = await runDefaultsHeartbeat({ defaultTimeoutSeconds, every: "30m" });
      expectReplyOptions(replyOpts, {
        isHeartbeat: true,
        timeoutOverrideSeconds: defaultTimeoutSeconds,
      });
    },
  );

  it("passes bootstrapContextMode when heartbeat lightContext is enabled", async () => {
    const replyOpts = await runDefaultsHeartbeat({ lightContext: true });
    expectReplyOptions(replyOpts, {
      isHeartbeat: true,
      bootstrapContextMode: "lightweight",
    });
  });

  it("retires the bundle MCP runtime only for isolated heartbeat runs", async () => {
    // Isolated runs mint a fresh session ID per heartbeat, so nothing reuses the runtime.
    const isolatedOpts = await runDefaultsHeartbeat({ isolatedSession: true });
    expectReplyOptions(isolatedOpts, { isHeartbeat: true, cleanupBundleMcpOnRunEnd: true });

    const sharedOpts = await runDefaultsHeartbeat({});
    expectReplyOptions(sharedOpts, { isHeartbeat: true, cleanupBundleMcpOnRunEnd: undefined });
  });

  it("uses isolated session key when isolatedSession is enabled", async () => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, replySpy, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              isolatedSession: true,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const result = await runHeartbeatWithSeed({
        seedSession,
        cfg,
        sessionKey,
        replySpy,
      });

      // Isolated heartbeat runs use a dedicated session key with :heartbeat suffix
      expect(result.ctx?.SessionKey).toBe(`${sessionKey}:heartbeat`);
    });
  });

  it("uses main session key when isolatedSession is not set", async () => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, replySpy, seedSession }) => {
      const cfg: OpenClawConfig = heartbeatTestConfig(tmpDir, "whatsapp", "whatsapp", storePath);
      const sessionKey = resolveMainSessionKey(cfg);
      const result = await runHeartbeatWithSeed({
        seedSession,
        cfg,
        sessionKey,
        replySpy,
      });

      expect(result.ctx?.SessionKey).toBe(sessionKey);
    });
  });

  it("passes per-agent heartbeat model override (merged with defaults)", async () => {
    await expectPerAgentHeartbeatOverride({
      defaultsHeartbeat: { model: "openai/gpt-5.4" },
      heartbeat: { model: "ollama/llama3.2:1b" },
      expectedOptions: {
        heartbeatModelOverride: "ollama/llama3.2:1b",
      },
    });
  });

  it("passes per-agent heartbeat lightContext override after merging defaults", async () => {
    await expectPerAgentHeartbeatOverride({
      defaultsHeartbeat: { lightContext: false },
      heartbeat: { lightContext: true },
      expectedOptions: {
        bootstrapContextMode: "lightweight",
      },
    });
  });

  it("passes per-agent heartbeat timeout override after merging defaults", async () => {
    await expectPerAgentHeartbeatOverride({
      defaultsHeartbeat: { timeoutSeconds: 120 },
      heartbeat: { timeoutSeconds: 45 },
      expectedOptions: {
        timeoutOverrideSeconds: 45,
      },
    });
  });

  it("does not pass heartbeatModelOverride when no heartbeat model is configured", async () => {
    const replyOpts = await runDefaultsHeartbeat({ model: undefined });
    const actual = expectReplyOptions(replyOpts, { isHeartbeat: true });
    expect(actual.heartbeatModelOverride).toBeUndefined();
  });

  it("trims heartbeat model override before passing it downstream", async () => {
    const replyOpts = await runDefaultsHeartbeat({ model: "  ollama/llama3.2:1b  " });
    expectReplyOptions(replyOpts, {
      isHeartbeat: true,
      heartbeatModelOverride: "ollama/llama3.2:1b",
    });
  });
});

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { AcpRuntime, AcpRuntimeTurnInput } from "@openclaw/acp-core/runtime/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { consumeAcpTurnStream } from "../../acp/control-plane/manager.turn-stream.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import type { HookMappingConfig } from "../../config/types.hooks.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent/run.types.js";
import { createSuiteLogPathTracker } from "../../logging/log-test-helpers.js";
import {
  applyLoggingConfig,
  flushLogger,
  resetLogger,
  setLoggerOverride,
} from "../../logging/logger.js";
import { parseLogLine } from "../../logging/parse-log-line.js";
import { loggingState } from "../../logging/state.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveHooksConfig } from "../hooks.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "../server-lanes.js";

const mocks = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  captureSessionEventTarget: vi.fn(async (agentId: string, sessionKey: string) => ({
    agentId,
    sessionKey,
    sessionId: "captured-session",
    generation: "captured-generation",
  })),
  enqueueSessionEvent: vi.fn((_text: string, _options: Record<string, unknown>) => ({
    accepted: Promise.resolve({ ok: true }),
    settled: Promise.resolve({ status: "completed" }),
  })),
  runCronIsolatedAgentTurn: vi.fn(),
}));

vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: mocks.runCronIsolatedAgentTurn,
}));
// mock-isolation: Keep ordinary reply execution outside the hook admission fixture.
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: mocks.captureSessionEventTarget,
  enqueueSessionEventForHost: mocks.enqueueSessionEvent,
}));
vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: mocks.enqueueSystemEvent,
  enqueueSystemEventWithReceipt: (...args: unknown[]) =>
    mocks.enqueueSystemEvent(...args) ? () => true : null,
}));

const { createGatewayHookDispatcher, createGatewayHooksRequestHandler } =
  await import("./hooks.js");

const pluginHookTurn = {
  name: "IMAP fastmail",
  agentId: "hooks",
  sessionKey: "hook:imap:fastmail:11:42",
  message: "New untrusted email",
  externalContentSource: "email" as const,
  deliver: false,
};

function createPluginHookDispatcher(options: { admissionTimeoutMs?: number } = {}) {
  const logHooks = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  const dispatcher = createGatewayHookDispatcher({
    deps: {} as never,
    logHooks: logHooks as never,
    agentStartAdmissionTimeoutMs: options.admissionTimeoutMs,
  });
  return { dispatcher, logHooks };
}

function queueHookRunner(onStart = vi.fn()) {
  mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
    async (params: { lane: string; onExecutionStarted?: () => void }) =>
      await enqueueCommandInLane(params.lane, async () => {
        params.onExecutionStarted?.();
        onStart();
        return { status: "ok", summary: "done" };
      }),
  );
  return onStart;
}

function createConfig(global: boolean): OpenClawConfig {
  return {
    agents: { entries: { main: {}, hooks: {} } },
    hooks: { enabled: true, token: "hook-secret" },
    ...(global ? { session: { scope: "global" } } : {}),
  };
}

async function postAgentHook(
  global: boolean,
  options: {
    admissionTimeoutMs?: number;
    rejectInitialConfig?: boolean;
    mapping?: HookMappingConfig;
    logger?: ReturnType<typeof createSubsystemLogger>;
  } = {},
) {
  const config = createConfig(global);
  if (options.mapping) {
    config.hooks = { ...config.hooks, mappings: [options.mapping] };
  }
  const hooksConfig = resolveHooksConfig(config);
  if (!hooksConfig) {
    throw new Error("expected resolved hooks config");
  }
  const logHooks = {
    warn: vi.fn(options.logger?.warn),
    debug: vi.fn(),
    info: vi.fn(options.logger?.info),
    error: vi.fn(),
  };
  const handler = createGatewayHooksRequestHandler({
    scheduler: createTestGatewayScheduler("fake-timers"),
    deps: {} as never,
    getHooksConfig: () => hooksConfig,
    getClientIpConfig: () => ({}),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: logHooks as never,
    agentStartAdmissionTimeoutMs: options.admissionTimeoutMs,
  });
  const req = Object.assign(
    Readable.from([JSON.stringify({ message: "Dispatch", name: "Recovery", agentId: "hooks" })]),
    {
      method: "POST",
      url: options.mapping ? "/hooks/terminal" : "/hooks/agent",
      headers: {
        authorization: "Bearer hook-secret",
        "content-type": "application/json",
      },
      socket: { remoteAddress: "127.0.0.1" },
    },
  ) as unknown as IncomingMessage;
  let responseBody = "";
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((chunk: string) => {
      responseBody = chunk;
    }),
  } as unknown as ServerResponse;

  if (options.rejectInitialConfig !== false) {
    mocks.getRuntimeConfig.mockImplementationOnce(() => {
      throw new Error("required system config unavailable");
    });
  }
  mocks.getRuntimeConfig.mockReturnValue(config);
  expect(await handler(req, res)).toBe(true);
  return { body: JSON.parse(responseBody) as { runId: string }, status: res.statusCode, logHooks };
}

describe("gateway hook early-failure recovery", () => {
  const logPathTracker = createSuiteLogPathTracker("openclaw-hook-terminal-");

  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetCommandQueueStateForTest();
    applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency({}));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await flushLogger();
    resetGatewayWorkAdmission();
    loggingState.rawConsole = null;
    resetLogger();
    resetCommandQueueStateForTest();
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  it.each([
    { outcome: "delivery", style: "pretty" },
    { outcome: "error", style: "compact" },
    { outcome: "skipped", style: "json" },
    { outcome: "throw", style: "compact" },
  ] as const)(
    "redacts and bounds $outcome diagnostics for the log reader and $style console sink",
    async ({ outcome, style }) => {
      applyLoggingConfig({
        redactPatterns: [String.raw`PRIVATE\[[^\]]+\]`],
      });
      const logPath = logPathTracker.nextPath();
      setLoggerOverride({
        level: "info",
        file: logPath,
        consoleLevel: "info",
        consoleStyle: style,
      });
      const sink = vi.fn();
      loggingState.rawConsole = { log: sink, info: sink, warn: sink, error: sink };
      const customSecret = `PRIVATE[${"x".repeat(550)}]`;
      const diagnostic = `line\nAuthorization: Bearer fake-secret-value\n${customSecret}\u0085tail\tend`;
      const result: RunCronAgentTurnResult = {
        status: outcome === "delivery" ? "ok" : outcome === "skipped" ? "skipped" : "error",
        ...(outcome === "delivery"
          ? { delivered: false, deliveryAttempted: true, deliveryError: diagnostic }
          : { error: diagnostic }),
        ...(outcome === "skipped" ? { admissionDisposition: "rejected" } : {}),
        sessionId: `session\u0000${customSecret}`,
        sessionKey: `agent:main:cron:${customSecret}`,
        model: `${"m".repeat(499)}🦞end`,
        outputText: "private output",
      };
      mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
        async (params: { onExecutionStarted?: () => void }) => {
          if (outcome !== "skipped") {
            params.onExecutionStarted?.();
          }
          if (outcome === "throw") {
            throw new Error(diagnostic);
          }
          return result;
        },
      );
      const response = await postAgentHook(false, {
        rejectInitialConfig: false,
        logger: createSubsystemLogger("gateway/hooks"),
        mapping: {
          match: { path: "terminal" },
          action: "agent",
          agentId: "main",
          name: `${"n".repeat(480)} ${customSecret}`,
          messageTemplate: "{{message}}",
          sessionKey: "hook:terminal",
          deliver: true,
        },
      });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(response.status).toBe(outcome === "skipped" ? 502 : 200);
      expect(response.body).toMatchObject({ ok: outcome !== "skipped", runId: expect.any(String) });
      expect(response.logHooks.warn).toHaveBeenCalledOnce();
      const meta = response.logHooks.warn.mock.calls[0]?.[1];
      expect(meta).toBeDefined();
      expect(meta).not.toHaveProperty("consoleMessage");
      await flushLogger();
      const lines = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      const fileLine = lines[0]!;
      const record = JSON.parse(fileLine);
      expect(record["1"]).toEqual(meta);
      expect(record["1"]).toMatchObject({
        runId: response.body.runId,
        status: result.status,
        agentId: "main",
        logicalSessionKey: "hook:terminal",
        [outcome === "delivery" ? "deliveryError" : "summary"]: expect.stringContaining("tail end"),
      });
      expect(record.agent_id).toBe("main");
      expect(record.session_id).toBe(outcome === "throw" ? undefined : meta?.sessionId);
      const parsed = parseLogLine(fileLine);
      expect(parsed).toMatchObject({ level: "warn", subsystem: "gateway/hooks" });
      const message = parsed!.message;
      expect.soft(message).toContain(`runId=${response.body.runId}`);
      expect.soft(message).toContain(`status=${result.status}`);
      expect
        .soft(message)
        .toContain(
          outcome === "delivery"
            ? "deliveryError=line"
            : outcome === "throw"
              ? "summary=Error: line"
              : "summary=line",
        );
      expect.soft(message).toContain("tail end");
      expect(message).toMatch(/^hook agent run completed /);
      expect(message.length).toBeLessThanOrEqual(500);
      expect(message).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
      expect(message).not.toMatch(/\p{Surrogate}/u);
      expect(fileLine).not.toMatch(/fake-secret-value|PRIVATE\[|x{20}|private output|Dispatch/);
      for (const value of Object.values(meta ?? {})) {
        if (typeof value !== "string") {
          continue;
        }
        expect(value.length).toBeLessThanOrEqual(500);
        expect(value).not.toMatch(/\p{Surrogate}/u);
        expect(value).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
        expect(value).not.toMatch(/fake-secret-value|PRIVATE\[|x{20}|private output/);
      }
      expect(meta?.[outcome === "delivery" ? "deliveryError" : "summary"]).toContain("tail end");
      expect(meta?.name).toContain("PRIVAT");
      if (outcome !== "throw") {
        expect(meta?.model).toBe("m".repeat(499));
      }
      expect(sink).toHaveBeenCalledOnce();
      const line = String(sink.mock.calls[0]?.[0]);
      expect(response.logHooks.warn.mock.calls[0]?.[0]).toBe(message);
      expect(line).not.toMatch(/fake-secret-value|PRIVATE\[|x{20}|private output/);
      if (style === "json") {
        expect(JSON.parse(line)).toMatchObject({
          level: "warn",
          runId: response.body.runId,
          status: "skipped",
          message,
        });
      } else {
        expect(line).toContain(message);
      }
      const events = outcome === "delivery" ? 0 : 1;
      expect(mocks.enqueueSessionEvent).toHaveBeenCalledTimes(events);
      expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    { scope: "agent-scoped", eventSessionKey: "agent:hooks:main" },
    { scope: "global", eventSessionKey: "global" },
  ])("keeps the accepted agent authoritative for $scope recovery", async (testCase) => {
    const global = testCase.scope === "global";
    const response = await postAgentHook(global);

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      ok: false,
      error: "hook agent run failed before entering the agent runner",
      runId: expect.any(String),
    });
    expect(mocks.runCronIsolatedAgentTurn).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(mocks.enqueueSessionEvent).toHaveBeenCalledTimes(1));
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledWith(
      "Hook Recovery (error): Error: required system config unavailable",
      expect.objectContaining({
        agentId: "hooks",
        sessionKey: testCase.eventSessionKey,
        source: "hook",
      }),
    );

    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it.each(["startTurn", "runTurn"] as const)(
    "does not invoke ACP %s after the final Gateway admission deadline rejects the prompt",
    async (runtimeApi) => {
      const releasePreparation = createDeferred();
      const handle = {
        sessionKey: "agent:hooks:acp:gateway-admission",
        backend: "test-acp",
        runtimeSessionName: "gateway-admission",
      };
      const startTurn = vi.fn((turn: AcpRuntimeTurnInput) => ({
        requestId: turn.requestId,
        promptStarted: Promise.resolve(),
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }));
      const runTurn = vi.fn((_turn: AcpRuntimeTurnInput) => (async function* () {})());
      const runtime = {
        ensureSession: vi.fn(async () => handle),
        ...(runtimeApi === "startTurn" ? { startTurn } : {}),
        runTurn,
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      } satisfies AcpRuntime;

      mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
        async (params: { onExecutionStarted?: () => void; abortSignal?: AbortSignal }) => {
          await releasePreparation.promise;
          const streamOptions = {
            runtime,
            turn: {
              handle,
              text: "Dispatch",
              mode: "prompt" as const,
              requestId: `gateway-admission-${runtimeApi}`,
              signal: params.abortSignal,
            },
            eventGate: { open: true },
            onBeforePrompt: params.onExecutionStarted,
            onPromptStarted: () => params.onExecutionStarted?.(),
          };
          await consumeAcpTurnStream(streamOptions);
          return { status: "ok", summary: "done" };
        },
      );

      try {
        const response = await postAgentHook(false, {
          admissionTimeoutMs: 10,
          rejectInitialConfig: false,
        });

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          ok: false,
          error: "hook agent run did not start before admission timeout",
        });
      } finally {
        releasePreparation.resolve();
      }

      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledOnce();
      expect(startTurn).not.toHaveBeenCalled();
      expect(runTurn).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "contains plugin email turns with HTTP hooks enabled=%s",
    async (enabled) => {
      const config: OpenClawConfig = {
        agents: { entries: { main: {}, hooks: {} } },
        hooks: {
          enabled,
          allowedAgentIds: ["main"],
          allowedSessionKeyPrefixes: ["hook:http:"],
        },
      };
      mocks.getRuntimeConfig.mockReturnValue(config);
      applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config));
      const onStart = queueHookRunner();
      const { dispatcher, logHooks } = createPluginHookDispatcher({ admissionTimeoutMs: 100 });
      const unsafePluginTurn = {
        ...pluginHookTurn,
        allowUnsafeExternalContent: true,
        sessionMode: "persistent",
      };

      const result = await dispatcher.dispatchHookAgentTurn(unsafePluginTurn, "imap");
      // Drain a closed lane after the regression fails; expired admission still fences execution.
      applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(createConfig(false)));
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

      expect(result).toEqual({ ok: true, runId: expect.any(String) });
      expect(onStart).toHaveBeenCalledOnce();
      expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "hooks",
          sessionKey: pluginHookTurn.sessionKey,
          lane: CommandLane.CronNested,
          job: expect.objectContaining({
            name: "IMAP fastmail",
            agentId: "hooks",
            sessionTarget: "isolated",
            payload: expect.objectContaining({
              kind: "agentTurn",
              message: pluginHookTurn.message,
              externalContentSource: "email",
              allowUnsafeExternalContent: undefined,
            }),
            delivery: { mode: "none" },
          }),
          executionIdentity: {
            ingress: {
              kind: "webhook",
              boundary: "gateway.hooks.plugin",
              state: "present",
              rawSourceRef: "imap:IMAP fastmail",
            },
          },
        }),
      );
      await vi.waitFor(() =>
        expect(logHooks.info).toHaveBeenCalledWith(
          expect.stringMatching(/^hook agent run completed /),
          expect.objectContaining({ name: "IMAP fastmail" }),
        ),
      );
    },
  );

  it("announces successful plugin hook turns through the ordinary event owner", async () => {
    mocks.getRuntimeConfig.mockReturnValue(createConfig(false));
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return { status: "ok", summary: "New email summarized" };
      },
    );
    const { dispatcher } = createPluginHookDispatcher();

    await expect(
      dispatcher.dispatchHookAgentTurn({ ...pluginHookTurn, deliver: true }, "imap"),
    ).resolves.toEqual({ ok: true, runId: expect.any(String) });

    await vi.waitFor(() =>
      expect(mocks.enqueueSessionEvent).toHaveBeenCalledWith(
        "Hook IMAP fastmail: New email summarized",
        expect.objectContaining({
          agentId: "hooks",
          sessionKey: "agent:hooks:main",
          source: "hook",
        }),
      ),
    );
  });

  it.each([
    { name: "missing agent ownership", override: { agentId: "  " }, reason: "agentId is required" },
    { name: "non-hook session", override: { sessionKey: "agent:hooks:main" } },
    { name: "empty hook session", override: { sessionKey: "hook:" } },
    { name: "session whitespace", override: { sessionKey: "hook:imap:bad value" } },
    { name: "trimmed session whitespace", override: { sessionKey: " hook:imap:message" } },
    {
      name: "non-email content",
      override: { externalContentSource: "webhook" as "email" },
      reason: "externalContentSource must be email",
    },
  ])("rejects plugin hook turns with $name before dispatch", async ({ override, reason }) => {
    const { dispatcher } = createPluginHookDispatcher();

    await expect(
      dispatcher.dispatchHookAgentTurn({ ...pluginHookTurn, ...override }, "imap"),
    ).resolves.toEqual({
      ok: false,
      reason:
        reason ??
        "sessionKey must start with hook: and contain no whitespace or control characters",
    });
    expect(mocks.runCronIsolatedAgentTurn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "session conflict",
      result: {
        status: "error",
        error: "session changed",
        admissionDisposition: "session-conflict",
      },
      reason: "hook agent run was rejected because the target session changed",
    },
    {
      name: "preparation failure",
      result: { status: "error", error: "provider preparation failed" },
      reason: "hook agent run failed before entering the agent runner",
    },
  ])("preserves plugin hook $name admission failure taxonomy", async ({ result, reason }) => {
    mocks.getRuntimeConfig.mockReturnValue(createConfig(false));
    mocks.runCronIsolatedAgentTurn.mockResolvedValueOnce(result);
    const { dispatcher } = createPluginHookDispatcher();

    await expect(dispatcher.dispatchHookAgentTurn(pluginHookTurn, "imap")).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it.each([false, true])(
    "bounds plugin work by cron capacity and fences expired admission=%s",
    async (expire) => {
      const config = { agents: createConfig(false).agents };
      mocks.getRuntimeConfig.mockReturnValue(config);
      applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config));
      const releaseCron = createDeferred();
      const cronRuns = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () =>
        enqueueCommandInLane(CommandLane.CronNested, async () => await releaseCron.promise),
      );
      const onStart = queueHookRunner();
      const { dispatcher } = createPluginHookDispatcher({
        admissionTimeoutMs: expire ? 100 : 5_000,
      });
      const admission = dispatcher.dispatchHookAgentTurn(pluginHookTurn, "imap");

      try {
        await vi.waitFor(() =>
          expect(getCommandLaneSnapshot(CommandLane.CronNested)).toMatchObject({
            activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
            queuedCount: 1,
          }),
        );
        expect(onStart).not.toHaveBeenCalled();
        if (!expire) {
          releaseCron.resolve();
        }
        await expect(admission).resolves.toEqual(
          expire
            ? {
                ok: false,
                reason: "hook agent run did not start before admission timeout",
              }
            : { ok: true, runId: expect.any(String) },
        );
      } finally {
        releaseCron.resolve();
        applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(createConfig(false)));
        await Promise.all(cronRuns);
        await admission;
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      }
      expect(onStart).toHaveBeenCalledTimes(expire ? 0 : 1);
      expect(getCommandLaneSnapshot(CommandLane.CronNested)).toMatchObject({
        activeCount: 0,
        queuedCount: 0,
      });
    },
  );

  it("serializes HTTP and plugin turns together while replaying plugin idempotency keys", async () => {
    const releaseHttpRun = createDeferred();
    mocks.getRuntimeConfig.mockReturnValue(createConfig(false));
    mocks.runCronIsolatedAgentTurn
      .mockImplementationOnce(async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        await releaseHttpRun.promise;
        return { status: "ok", summary: "HTTP done" };
      })
      .mockImplementationOnce(async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return { status: "ok", summary: "plugin done" };
      });
    const { dispatcher } = createPluginHookDispatcher();
    const httpResult = await dispatcher.dispatchAgentHook({
      ...pluginHookTurn,
      effectiveAgentId: "hooks",
      sessionMode: "isolated",
      sourcePath: "/hooks/gmail",
      wakeMode: "now",
      channel: "last",
      delivery: { mode: "none" },
      externalContentSource: "gmail",
    });
    expect(httpResult.ok).toBe(true);

    const pluginTurn = { ...pluginHookTurn, idempotencyKey: "message-42" };
    const firstPluginRun = dispatcher.dispatchHookAgentTurn(pluginTurn, "imap");
    const duplicatePluginRun = dispatcher.dispatchHookAgentTurn(pluginTurn, "imap");
    expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledOnce();

    releaseHttpRun.resolve();
    const [first, duplicate] = await Promise.all([firstPluginRun, duplicatePluginRun]);
    expect(first).toEqual({ ok: true, runId: expect.any(String) });
    expect(duplicate).toEqual(first);
    await expect(dispatcher.dispatchHookAgentTurn(pluginTurn, "imap")).resolves.toEqual(first);
    expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledTimes(2);
  });
});

const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  hooks: {
    enabled: true,
    token: "hook-secret",
    presets: ["gmail"],
    defaultSessionKey: "hook:gmail:ingress",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:gmail:"],
  },
};

function createHandler(admissionTimeoutMs: number) {
  const hooksConfig = resolveHooksConfig(config);
  if (!hooksConfig) {
    throw new Error("expected resolved hooks config");
  }
  return createGatewayHooksRequestHandler({
    scheduler: createTestGatewayScheduler("fake-timers"),
    deps: {} as never,
    getHooksConfig: () => hooksConfig,
    getClientIpConfig: () => ({}),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    agentStartAdmissionTimeoutMs: admissionTimeoutMs,
  });
}

async function post(
  handler: ReturnType<typeof createGatewayHooksRequestHandler>,
  path: string,
  payload: Record<string, unknown>,
) {
  const req = Object.assign(Readable.from([JSON.stringify(payload)]), {
    method: "POST",
    url: path,
    headers: {
      authorization: "Bearer hook-secret",
      "content-type": "application/json",
    },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
  let responseBody = "";
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((chunk?: string) => {
      if (typeof chunk === "string") {
        responseBody = chunk;
      }
    }),
  } as unknown as ServerResponse;
  expect(await handler(req, res)).toBe(true);
  return { res, body: () => responseBody };
}

describe("hook background admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admits slow fan-out items past the bounded deadline instead of canceling them", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    // Execution starts well after the 20ms bounded admission deadline,
    // mirroring cold concurrent workspace prep.
    mocks.runCronIsolatedAgentTurn.mockImplementation(
      async (params: { onExecutionStarted?: () => void; abortSignal?: AbortSignal }) => {
        await delay(60);
        expect(params.abortSignal?.aborted).toBe(false);
        params.onExecutionStarted?.();
        return { status: "ok" as const };
      },
    );
    const handler = createHandler(20);

    const response = await post(handler, "/hooks/gmail", {
      messages: [
        { id: "bg1", from: "a@example.com", subject: "One" },
        { id: "bg2", from: "b@example.com", subject: "Two" },
      ],
    });

    expect(response.res.statusCode).toBe(200);
    const body = JSON.parse(response.body()) as { runIds?: string[] };
    expect(body.runIds).toHaveLength(2);
    expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("announces a pre-execution fan-out failure once across producer redeliveries", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.runCronIsolatedAgentTurn.mockResolvedValue({
      status: "skipped" as const,
      error: "model provider unavailable",
      admissionDisposition: "rejected" as const,
    });
    const handler = createHandler(100);
    const redelivered = { messages: [{ id: "alert1", from: "a@example.com", subject: "Alert" }] };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(handler, "/hooks/gmail", redelivered);
      expect(response.res.statusCode).toBe(502);
    }
    await post(handler, "/hooks/gmail", {
      messages: [{ id: "alert2", from: "b@example.com", subject: "Other" }],
    });

    expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledTimes(4);
    expect(mocks.enqueueSessionEvent.mock.calls.map(([text]) => text)).toEqual([
      "Hook Gmail (skipped): model provider unavailable",
      "Hook Gmail (skipped): model provider unavailable",
    ]);

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1);
    try {
      expect((await post(handler, "/hooks/gmail", redelivered)).res.statusCode).toBe(502);
      expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledTimes(5);
      expect(mocks.enqueueSessionEvent.mock.calls.map(([text]) => text)).toEqual([
        "Hook Gmail (skipped): model provider unavailable",
        "Hook Gmail (skipped): model provider unavailable",
        "Hook Gmail (skipped): model provider unavailable",
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("announces an execution failure after an earlier redelivery failed admission", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.runCronIsolatedAgentTurn
      .mockResolvedValueOnce({
        status: "skipped" as const,
        error: "model provider unavailable",
        admissionDisposition: "rejected" as const,
      })
      .mockImplementationOnce(async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return { status: "error" as const, error: "execution failed" };
      });
    const handler = createHandler(100);
    const redelivered = { messages: [{ id: "alert3", from: "c@example.com", subject: "Alert" }] };

    expect((await post(handler, "/hooks/gmail", redelivered)).res.statusCode).toBe(502);
    expect((await post(handler, "/hooks/gmail", redelivered)).res.statusCode).toBe(200);

    await vi.waitFor(() =>
      expect(mocks.enqueueSessionEvent.mock.calls.map(([text]) => text)).toEqual([
        "Hook Gmail (skipped): model provider unavailable",
        "Hook Gmail (error): execution failed",
      ]),
    );
  });

  it("keeps the bounded admission cancel for direct agent hooks", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    let sawAbort = false;
    mocks.runCronIsolatedAgentTurn.mockImplementation(
      async (params: { onExecutionStarted?: () => void; abortSignal?: AbortSignal }) => {
        await delay(60);
        sawAbort = params.abortSignal?.aborted === true;
        if (!sawAbort) {
          params.onExecutionStarted?.();
        }
        return { status: "ok" as const };
      },
    );
    const handler = createHandler(20);

    const response = await post(handler, "/hooks/agent", { message: "Direct", name: "Bounded" });

    expect(response.res.statusCode).toBe(503);
    // The canceled run must not proceed after the 503.
    await delay(80);
    expect(sawAbort).toBe(true);
  });

  it.each([{ deliverySuppressionReason: "empty", replyDisposition: "empty" }] as const)(
    "returns the $deliverySuppressionReason terminal suppression reason to an explicit waiter",
    async ({ deliverySuppressionReason, replyDisposition }) => {
      mocks.getRuntimeConfig.mockReturnValue(config);
      mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
        async (params: { onExecutionStarted?: () => void }) => {
          params.onExecutionStarted?.();
          return {
            status: "ok" as const,
            delivered: false,
            deliveryAttempted: true,
            deliverySuppressionReason,
            replyDisposition,
            outputText: "private output",
            summary: "private summary",
            sessionId: "private-session",
            sessionKey: "private-session-key",
          };
        },
      );
      const handler = createHandler(100);

      const response = await post(handler, "/hooks/agent", {
        message: "Direct",
        name: "Observed",
        waitForCompletion: true,
      });

      expect(response.res.statusCode).toBe(200);
      expect(JSON.parse(response.body())).toEqual({
        ok: true,
        runId: expect.any(String),
        completion: {
          status: "ok",
          replyDisposition,
          delivered: false,
          deliveryAttempted: true,
          deliverySuppressionReason,
        },
      });
    },
  );

  it("returns categorical delivery failure without private run data", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    const secret = "fake-secret-value-that-must-not-leak";
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return {
          status: "ok" as const,
          replyDisposition: "visible" as const,
          delivered: false,
          deliveryAttempted: true,
          deliveryError: `line\nAuthorization: Bearer ${secret}\n${"x".repeat(600)} tail`,
          outputText: "private output",
          summary: "private summary",
          sessionId: "private-session",
          sessionKey: "private-session-key",
        };
      },
    );
    const handler = createHandler(100);

    const response = await post(handler, "/hooks/agent", {
      message: "Direct",
      name: "Observed",
      deliver: false,
      waitForCompletion: true,
    });

    const body = JSON.parse(response.body()) as {
      completion: { deliveryError: string };
    };
    expect(response.res.statusCode).toBe(200);
    expect(body).toMatchObject({
      completion: {
        status: "ok",
        replyDisposition: "visible",
        delivered: false,
        deliveryAttempted: true,
        deliveryError: "delivery-failed",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /Authorization|fake-secret-value|private output|private summary|private-session|x{20}/,
    );
  });

  it("settles an admitted waiter when the isolated runner throws", async () => {
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        throw new Error("private execution diagnostic");
      },
    );
    const handler = createHandler(100);

    const response = await post(handler, "/hooks/agent", {
      message: "Direct",
      name: "Observed",
      waitForCompletion: true,
    });

    expect(response.res.statusCode).toBe(200);
    expect(JSON.parse(response.body())).toEqual({
      ok: true,
      runId: expect.any(String),
      completion: { status: "error", replyDisposition: "empty" },
    });
  });
});

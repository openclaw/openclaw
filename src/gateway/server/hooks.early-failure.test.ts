import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
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
import { createMockServerResponse } from "../../test-utils/mock-http-response.js";
import { resolveHooksConfig } from "../hooks.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "../server-lanes.js";

const mocks = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  config: vi.fn<() => OpenClawConfig>(),
  captureSessionEventTarget: vi.fn(async (agentId: string, sessionKey: string) => ({
    agentId,
    sessionKey,
    sessionId: "captured-session",
    generation: "captured-generation",
  })),
  enqueue: vi.fn((_text: string, _options: Record<string, unknown>) => ({
    accepted: Promise.resolve({ ok: true }),
    settled: Promise.resolve({ status: "completed" }),
  })),
  run: vi.fn(),
}));

vi.mock("../../config/io.js", () => ({ getRuntimeConfig: mocks.config }));
vi.mock("../../cron/isolated-agent.js", () => ({ runCronIsolatedAgentTurn: mocks.run }));
// mock-isolation: Keep ordinary reply execution outside the hook admission fixture.
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: mocks.captureSessionEventTarget,
  enqueueSessionEventForHost: mocks.enqueue,
}));
vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: mocks.enqueueSystemEvent,
  enqueueSystemEventWithReceipt: (...args: unknown[]) =>
    mocks.enqueueSystemEvent(...args) ? () => true : null,
}));

const { createGatewayHookDispatcher, createGatewayHooksRequestHandler } =
  await import("./hooks.js");

const waitForIdle = () => vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
const eventTexts = () => mocks.enqueue.mock.calls.map(([text]) => text);
const acceptedRun = { ok: true, runId: expect.any(String) };
const unavailable = {
  status: "skipped" as const,
  error: "model provider unavailable",
  admissionDisposition: "rejected" as const,
};

function mockStartedRun(result: RunCronAgentTurnResult | Error, gate?: Promise<void>) {
  mocks.run.mockImplementationOnce(async (params: { onExecutionStarted?: () => void }) => {
    params.onExecutionStarted?.();
    if (gate) {
      await gate;
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
}

function createLogHooks(logger?: ReturnType<typeof createSubsystemLogger>) {
  return { warn: vi.fn(logger?.warn), debug: vi.fn(), info: vi.fn(logger?.info), error: vi.fn() };
}

const expectEvent = async (text: string, sessionKey: string) =>
  await vi.waitFor(() =>
    expect(mocks.enqueue).toHaveBeenCalledWith(
      text,
      expect.objectContaining({ agentId: "hooks", sessionKey, source: "hook" }),
    ),
  );

const privateRunData = {
  outputText: "private output",
  summary: "private summary",
  sessionId: "private-session",
  sessionKey: "private-session-key",
};

const pluginHookTurn = {
  name: "IMAP fastmail",
  agentId: "hooks",
  sessionKey: "hook:imap:fastmail:11:42",
  message: "New untrusted email",
  externalContentSource: "email" as const,
  deliver: false,
};

function createPluginHookDispatcher(options: { admissionTimeoutMs?: number } = {}) {
  const logHooks = createLogHooks();
  const dispatcher = createGatewayHookDispatcher({
    deps: {} as never,
    logHooks: logHooks as never,
    agentStartAdmissionTimeoutMs: options.admissionTimeoutMs,
  });
  return { dispatcher, logHooks };
}

function queueHookRunner(onStart = vi.fn()) {
  mocks.run.mockImplementationOnce(
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
  const logHooks = createLogHooks(options.logger);
  const handler = createHandler(options.admissionTimeoutMs, hooksConfig, logHooks);
  if (options.rejectInitialConfig !== false) {
    mocks.config.mockImplementationOnce(() => {
      throw new Error("required system config unavailable");
    });
  }
  mocks.config.mockReturnValue(config);
  const response = await post(handler, options.mapping ? "/hooks/terminal" : "/hooks/agent", {
    message: "Dispatch",
    name: "Recovery",
    agentId: "hooks",
  });
  return { ...response, logHooks };
}

describe("gateway hook early-failure recovery", () => {
  const logPathTracker = createSuiteLogPathTracker("openclaw-hook-terminal-");

  beforeAll(() => logPathTracker.setup());

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

  afterAll(() => logPathTracker.cleanup());

  it.each([
    { outcome: "delivery", style: "pretty" },
    { outcome: "error", style: "compact" },
    { outcome: "skipped", style: "json" },
    { outcome: "throw", style: "compact" },
  ] as const)(
    "redacts and bounds $outcome diagnostics for the log reader and $style console sink",
    async ({ outcome, style }) => {
      applyLoggingConfig({ redactPatterns: [String.raw`PRIVATE\[[^\]]+\]`] });
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
      mocks.run.mockImplementationOnce(async (params: { onExecutionStarted?: () => void }) => {
        if (outcome !== "skipped") {
          params.onExecutionStarted?.();
        }
        if (outcome === "throw") {
          throw new Error(diagnostic);
        }
        return result;
      });
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
      await waitForIdle();
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
      for (const fragment of [
        `runId=${response.body.runId}`,
        `status=${result.status}`,
        outcome === "delivery"
          ? "deliveryError=line"
          : outcome === "throw"
            ? "summary=Error: line"
            : "summary=line",
        "tail end",
      ]) {
        expect.soft(message).toContain(fragment);
      }
      expect(message).toMatch(/^hook agent run completed /);
      expect(message.length).toBeLessThanOrEqual(500);
      expect(message).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}\p{Surrogate}]/u);
      expect(fileLine).not.toMatch(/fake-secret-value|PRIVATE\[|x{20}|private output|Dispatch/);
      for (const value of Object.values(meta ?? {})) {
        if (typeof value !== "string") {
          continue;
        }
        expect(value.length).toBeLessThanOrEqual(500);
        expect(value).not.toMatch(
          /[\p{Cc}\p{Zl}\p{Zp}\p{Surrogate}]|fake-secret-value|PRIVATE\[|x{20}|private output/u,
        );
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
      expect(mocks.enqueue).toHaveBeenCalledTimes(events);
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
    expect(mocks.run).not.toHaveBeenCalled();

    await expectEvent(
      "Hook Recovery (error): Error: required system config unavailable",
      testCase.eventSessionKey,
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);

    await waitForIdle();
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
      const startTurn = vi.fn<NonNullable<AcpRuntime["startTurn"]>>();
      const runTurn = vi.fn<AcpRuntime["runTurn"]>();
      const runtime = {
        ensureSession: vi.fn(async () => handle),
        ...(runtimeApi === "startTurn" ? { startTurn } : {}),
        runTurn,
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      } satisfies AcpRuntime;

      mocks.run.mockImplementationOnce(
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

      await waitForIdle();
      expect(mocks.run).toHaveBeenCalledOnce();
      expect(startTurn).not.toHaveBeenCalled();
      expect(runTurn).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "contains plugin email turns with HTTP hooks enabled=%s",
    async (enabled) => {
      const config = {
        ...createConfig(false),
        hooks: {
          enabled,
          allowedAgentIds: ["main"],
          allowedSessionKeyPrefixes: ["hook:http:"],
        },
      };
      mocks.config.mockReturnValue(config);
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
      await waitForIdle();

      expect(result).toEqual(acceptedRun);
      expect(onStart).toHaveBeenCalledOnce();
      expect(mocks.run).toHaveBeenCalledWith(
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
    mocks.config.mockReturnValue(createConfig(false));
    mockStartedRun({ status: "ok", summary: "New email summarized" });
    const { dispatcher } = createPluginHookDispatcher();

    await expect(
      dispatcher.dispatchHookAgentTurn({ ...pluginHookTurn, deliver: true }, "imap"),
    ).resolves.toEqual(acceptedRun);

    await expectEvent("Hook IMAP fastmail: New email summarized", "agent:hooks:main");
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
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "bounds plugin work by cron capacity and fences expired admission=%s",
    async (expire) => {
      const config = { agents: createConfig(false).agents };
      mocks.config.mockReturnValue(config);
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
            ? { ok: false, reason: "hook agent run did not start before admission timeout" }
            : acceptedRun,
        );
      } finally {
        releaseCron.resolve();
        applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(createConfig(false)));
        await Promise.all(cronRuns);
        await admission;
        await waitForIdle();
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
    mocks.config.mockReturnValue(createConfig(false));
    mockStartedRun({ status: "ok", summary: "HTTP done" }, releaseHttpRun.promise);
    mockStartedRun({ status: "ok", summary: "plugin done" });
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
    expect(mocks.run).toHaveBeenCalledOnce();

    releaseHttpRun.resolve();
    const [first, duplicate] = await Promise.all([firstPluginRun, duplicatePluginRun]);
    expect(first).toEqual(acceptedRun);
    expect(duplicate).toEqual(first);
    await expect(dispatcher.dispatchHookAgentTurn(pluginTurn, "imap")).resolves.toEqual(first);
    expect(mocks.run).toHaveBeenCalledTimes(2);
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

const gmailMessages = (...ids: string[]) => ({
  messages: ids.map((id) => ({ id, from: "a@example.com", subject: id })),
});

function createHandler(
  admissionTimeoutMs: number | undefined,
  hooksConfig = resolveHooksConfig(config),
  logHooks = createLogHooks(),
) {
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
    logHooks: logHooks as never,
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
    headers: { authorization: "Bearer hook-secret", "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
  const res = createMockServerResponse();
  expect(await handler(req, res)).toBe(true);
  return {
    status: res.statusCode,
    body: JSON.parse(res.body ?? "") as { runId: string; runIds?: string[] },
  };
}

describe("hook background admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["fan-out", "direct"] as const)(
    "applies the bounded admission deadline only to direct hooks: %s",
    async (mode) => {
      mocks.config.mockReturnValue(config);
      const direct = mode === "direct";
      const observedAbort: boolean[] = [];
      mocks.run.mockImplementation(
        async (params: { onExecutionStarted?: () => void; abortSignal?: AbortSignal }) => {
          await delay(60);
          const aborted = params.abortSignal?.aborted === true;
          observedAbort.push(aborted);
          if (!aborted) {
            params.onExecutionStarted?.();
          }
          return { status: "ok" as const };
        },
      );
      const response = await post(
        createHandler(20),
        direct ? "/hooks/agent" : "/hooks/gmail",
        direct ? { message: "Direct", name: "Bounded" } : gmailMessages("bg1", "bg2"),
      );
      expect(response.status).toBe(direct ? 503 : 200);
      if (direct) {
        await delay(80);
      } else {
        expect(response.body.runIds).toHaveLength(2);
        expect(mocks.run).toHaveBeenCalledTimes(2);
      }
      expect(observedAbort).toEqual(direct ? [true] : [false, false]);
    },
  );

  it("announces a pre-execution fan-out failure once across producer redeliveries", async () => {
    mocks.config.mockReturnValue(config);
    mocks.run.mockResolvedValue(unavailable);
    const handler = createHandler(100);
    const redelivered = gmailMessages("alert1");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(handler, "/hooks/gmail", redelivered);
      expect(response.status).toBe(502);
    }
    await post(handler, "/hooks/gmail", gmailMessages("alert2"));

    expect(mocks.run).toHaveBeenCalledTimes(4);
    expect(eventTexts()).toEqual([
      "Hook Gmail (skipped): model provider unavailable",
      "Hook Gmail (skipped): model provider unavailable",
    ]);

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1);
    try {
      expect((await post(handler, "/hooks/gmail", redelivered)).status).toBe(502);
      expect(mocks.run).toHaveBeenCalledTimes(5);
      expect(eventTexts()).toEqual([
        "Hook Gmail (skipped): model provider unavailable",
        "Hook Gmail (skipped): model provider unavailable",
        "Hook Gmail (skipped): model provider unavailable",
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("announces an execution failure after an earlier redelivery failed admission", async () => {
    mocks.config.mockReturnValue(config);
    mocks.run.mockResolvedValueOnce(unavailable);
    mockStartedRun({ status: "error", error: "execution failed" });
    const handler = createHandler(100);
    const redelivered = gmailMessages("alert3");

    expect((await post(handler, "/hooks/gmail", redelivered)).status).toBe(502);
    expect((await post(handler, "/hooks/gmail", redelivered)).status).toBe(200);

    await vi.waitFor(() =>
      expect(eventTexts()).toEqual([
        "Hook Gmail (skipped): model provider unavailable",
        "Hook Gmail (error): execution failed",
      ]),
    );
  });

  it.each(["suppression", "delivery failure", "throw"] as const)(
    "returns only public completion fields after %s",
    async (outcome) => {
      mocks.config.mockReturnValue(config);
      if (outcome === "throw") {
        mockStartedRun(new Error("private execution diagnostic"));
      } else {
        mockStartedRun({
          status: "ok",
          delivered: false,
          deliveryAttempted: true,
          ...privateRunData,
          ...(outcome === "suppression"
            ? { deliverySuppressionReason: "empty" as const, replyDisposition: "empty" as const }
            : {
                replyDisposition: "visible" as const,
                deliveryError: `line\nAuthorization: Bearer fake-secret-value-that-must-not-leak\n${"x".repeat(600)} tail`,
              }),
        });
      }
      const response = await post(createHandler(100), "/hooks/agent", {
        message: "Direct",
        name: "Observed",
        waitForCompletion: true,
        ...(outcome === "delivery failure" ? { deliver: false } : {}),
      });
      expect(response.status).toBe(200);
      const { body } = response;
      if (outcome === "delivery failure") {
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
      } else {
        expect(body).toEqual({
          ...acceptedRun,
          completion:
            outcome === "throw"
              ? { status: "error", replyDisposition: "empty" }
              : {
                  status: "ok",
                  replyDisposition: "empty",
                  delivered: false,
                  deliveryAttempted: true,
                  deliverySuppressionReason: "empty",
                },
        });
      }
    },
  );
});

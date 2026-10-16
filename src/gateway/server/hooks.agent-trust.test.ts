import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import {
  captureGatewayRootWorkReleaseObserver,
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { getSpawnBroker, runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../../process/spawn-broker/host.test-support.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { HookAgentDispatchPayload } from "../hooks.js";

const enqueueSystem = vi.fn();
const captureTarget = vi.fn(async (agentId: string, sessionKey: string) => ({
  agentId,
  sessionKey,
  sessionId: "captured-session",
  generation: "captured-generation",
}));
const enqueueEvent = vi.fn((_text: string, _options: Record<string, unknown>) => ({
  accepted: Promise.resolve({ ok: true }),
  settled: Promise.resolve({ status: "completed" }),
}));
const runAgent = vi.fn();
const resolveMainSessionKeyMock = vi.fn(() => "main-session");
const resolveMainKey = vi.fn(
  (params: { cfg?: { session?: { mainKey?: string } }; agentId: string }) =>
    `agent:${params.agentId}:${params.cfg?.session?.mainKey ?? "main"}`,
);
const mainRosterConfig = (): OpenClawConfig => ({ agents: { entries: { main: {} } } });
const loadConfig = vi.fn(mainRosterConfig);
const logHooksInfoMock = vi.fn();
const logHooksWarnMock = vi.fn<SubsystemLogger["warn"]>();
const validateAccount = vi.fn(
  ({ accountId }: { accountId?: unknown }) => accountId as string | undefined,
);
const resolveOutboundChannelPluginMock = vi.fn(() => ({ id: "telegram" }));
const resolveChannelDefaultAccountIdMock = vi.fn(() => "default");

vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: enqueueSystem,
  enqueueSystemEventWithReceipt: (...args: unknown[]) =>
    enqueueSystem(...args) ? () => true : null,
}));
// mock-isolation: Observe hook handoff without admitting an unrelated ordinary reply turn.
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: captureTarget,
  enqueueSessionEventForHost: enqueueEvent,
}));
vi.mock("../../cron/isolated-agent.js", () => ({ runCronIsolatedAgentTurn: runAgent }));
vi.mock("../../infra/outbound/message-account-selection.js", () => ({
  validateExplicitMessageAccountSelection: validateAccount,
}));
vi.mock("../../infra/outbound/channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: resolveOutboundChannelPluginMock,
}));
vi.mock("../../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: resolveChannelDefaultAccountIdMock,
}));
vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: resolveMainSessionKeyMock,
  resolveMainSessionKey: vi.fn((cfg?: { session?: { mainKey?: string; scope?: string } }) =>
    cfg?.session?.scope === "global" ? "global" : `agent:main:${cfg?.session?.mainKey ?? "main"}`,
  ),
  resolveAgentMainSessionKey: resolveMainKey,
}));
vi.mock("../../config/io.js", () => ({ getRuntimeConfig: loadConfig }));

import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";

let capturedDispatchAgentHook: ((...args: unknown[]) => unknown) | undefined;
let capturedDispatchWakeHook: ((...args: unknown[]) => unknown) | undefined;

vi.mock("./hooks-request-handler.js", () => ({
  createHooksRequestHandler: vi.fn((opts: Record<string, unknown>) => {
    capturedDispatchAgentHook = opts.dispatchAgentHook as typeof capturedDispatchAgentHook;
    capturedDispatchWakeHook = opts.dispatchWakeHook as typeof capturedDispatchWakeHook;
    return vi.fn();
  }),
}));

const { createGatewayHookDispatcher, createGatewayHooksRequestHandler } =
  await import("./hooks.js");
const createBroker = useSpawnBrokerTestFixture(afterEach);

const waitForFast = (check: () => void) => vi.waitFor(check, { interval: 1 });
const waitForIdle = () => waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
const waitForCompletionEvent = (text: string) =>
  waitForFast(() =>
    expect(enqueueEvent).toHaveBeenCalledWith(
      text,
      expect.objectContaining({ agentId: "main", sessionKey: "agent:main:main", source: "hook" }),
    ),
  );
function queueRun(
  gate: ReturnType<typeof createDeferred>,
  summary: string,
  onStarted?: () => void,
) {
  runAgent.mockImplementationOnce(async (params: { onExecutionStarted?: () => void }) => {
    params.onExecutionStarted?.();
    onStarted?.();
    await gate.promise;
    return completedRun(summary);
  });
}

function buildMinimalParams(overrides: { agentStartAdmissionTimeoutMs?: number } = {}) {
  return {
    scheduler: createTestGatewayScheduler("fake-timers"),
    deps: {} as never,
    getHooksConfig: () => null,
    getClientIpConfig: () => ({ trustedProxies: undefined, allowRealIpFallback: false }),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: {
      warn: logHooksWarnMock,
      debug: vi.fn(),
      info: logHooksInfoMock,
      error: vi.fn(),
    } as never,
    ...overrides,
  };
}

function buildAgentPayload(name: string, overrides: Partial<HookAgentDispatchPayload> = {}) {
  return {
    message: "test message",
    name,
    effectiveAgentId: "main",
    wakeMode: "now" as const,
    sessionKey: "session-1",
    sessionMode: "isolated" as const,
    sourcePath: "/hooks/agent",
    deliver: false,
    channel: "last" as const,
    delivery: { mode: "none" as const },
    ...overrides,
  };
}

function completedRun(summary = "done") {
  return { status: "ok", summary, delivered: false };
}

function dispatchAgentHook(
  name: string,
  overrides: Partial<HookAgentDispatchPayload> = {},
): unknown {
  assert(capturedDispatchAgentHook, "dispatchAgentHook missing");
  return capturedDispatchAgentHook(buildAgentPayload(name, overrides));
}

function deliveryPayload(accountId?: string): Partial<HookAgentDispatchPayload> {
  return {
    deliver: true,
    channel: "telegram",
    to: "123456",
    ...(accountId ? { accountId } : {}),
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: "123456",
      ...(accountId ? { accountId } : {}),
    },
  };
}

function dispatchWakeHook(payload: unknown, agentId: string): unknown {
  if (!capturedDispatchWakeHook) {
    throw new Error("dispatchWakeHook missing");
  }
  return capturedDispatchWakeHook(payload, agentId);
}

describe("dispatchAgentHook trust handling", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    loadConfig.mockImplementation(mainRosterConfig);
    validateAccount.mockImplementation(
      ({ accountId }: { accountId?: unknown }) => accountId as string | undefined,
    );
    resolveOutboundChannelPluginMock.mockReturnValue({ id: "telegram" });
    resolveChannelDefaultAccountIdMock.mockReturnValue("default");
    capturedDispatchAgentHook = undefined;
    capturedDispatchWakeHook = undefined;
    createGatewayHooksRequestHandler(buildMinimalParams());
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
  });

  it("queues and targets a deferred mapped global wake for the same agent", async () => {
    loadConfig.mockReturnValue({
      agents: { entries: { main: {}, hooks: {} } },
      session: { scope: "global" },
    });

    await dispatchWakeHook(
      { text: "Mapped wake", mode: "next-heartbeat", sessionKey: "hook:mapped" },
      "hooks",
    );

    expect(enqueueSystem.mock.calls.find(([text]) => text === "Mapped wake")?.[1]).toEqual({
      sessionKey: "agent:hooks:global",
    });
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(captureTarget).not.toHaveBeenCalled();
  });

  it("keeps the resolved owner when a deferred multi-agent wake omits agentId", async () => {
    loadConfig.mockReturnValue({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, molty: {} },
      },
    });

    enqueueSystem.mockReturnValue(false);
    const result = await dispatchWakeHook({ text: "Mapped wake", mode: "next-heartbeat" }, "molty");

    expect(result).toEqual({ eventOutcome: "coalesced" });
    expect(resolveMainKey).toHaveBeenCalledWith({ cfg: expect.any(Object), agentId: "molty" });
    expect(enqueueSystem).toHaveBeenCalledWith("Mapped wake", { sessionKey: "agent:molty:main" });
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("gives a queued hook run its owning Gateway context and broker", async () => {
    const broker = await createBroker();
    const gatewayContext = {
      terminalSessions: {},
      resolveGatewayContext: () => gatewayContext,
    } as never;
    let observed: unknown = "never-ran";
    let observedClient: unknown = "never-ran";
    let observedBroker: unknown = "never-ran";
    runAgent.mockImplementationOnce(async () => {
      const scope = getPluginRuntimeGatewayRequestScope();
      observed = scope?.resolveGatewayContext?.();
      observedClient = scope?.client;
      observedBroker = getSpawnBroker();
      return { status: "ok", summary: "done", delivered: false };
    });
    runWithSpawnBroker(broker, () =>
      createGatewayHooksRequestHandler({
        ...buildMinimalParams(),
        resolveGatewayContext: () => gatewayContext,
      }),
    );

    await withPluginRuntimeGatewayRequestScope({ client: { id: "retired-request" } } as never, () =>
      dispatchAgentHook("Gateway context"),
    );

    expect(observed).toBe(gatewayContext);
    expect(observedClient).toBeUndefined();
    expect(observedBroker).toBe(broker);
    await waitForIdle();
  });

  it.each(["initial", "queued"] as const)(
    "rejects invalid delivery accounts at %s validation",
    async (phase) => {
      if (phase === "queued") {
        validateAccount.mockImplementationOnce(
          ({ accountId }: { accountId?: unknown }) => accountId as string,
        );
      }
      validateAccount.mockImplementationOnce(() => {
        throw new Error('Unknown account "missing" for channel telegram.');
      });
      const result = await dispatchAgentHook("Invalid account", deliveryPayload("missing"));
      expect(result).toMatchObject({
        ok: false,
        statusCode: 400,
        error: 'Unknown account "missing" for channel telegram.',
        runId: expect.any(String),
      });
      expect(runAgent).not.toHaveBeenCalled();
    },
  );

  it("binds omitted delivery accounts to the channel default", async () => {
    runAgent.mockResolvedValueOnce({ status: "ok", summary: "done", delivered: true });

    const result = await dispatchAgentHook("Default account", deliveryPayload());

    expect(result).toMatchObject({ ok: true });
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "event",
        job: expect.objectContaining({
          delivery: expect.objectContaining({ accountId: "default" }),
        }),
      }),
    );
  });

  it("retains detached agent work after the hook request closes", async () => {
    const requestWork = new AsyncWorkScope();
    const runGate = createDeferred();
    const runReleased = createDeferred();
    let subordinateAdmissionClosed: boolean | undefined;
    runAgent.mockImplementationOnce(async (params: { onExecutionStarted?: () => void }) => {
      const observeRelease = captureGatewayRootWorkReleaseObserver();
      assert(observeRelease, "hook execution must own root admission");
      observeRelease(() => runReleased.resolve());
      params.onExecutionStarted?.();
      await runGate.promise;
      const signal = getAsyncWorkSignal();
      assert(signal, "hook execution must own its cancellation scope");
      signal.throwIfAborted();
      subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
      return { status: "ok", summary: "done", delivered: false };
    });
    const dispatcher = createGatewayHookDispatcher(buildMinimalParams());
    const requestAdmission = tryBeginGatewayRootWorkAdmission();
    assert(requestAdmission, "hook request must acquire admission");

    try {
      const admission = await requestWork.track(() =>
        requestAdmission.run(() => dispatcher.dispatchAgentHook(buildAgentPayload("Async hook"))),
      );
      assert(admission.ok, "hook must acknowledge execution before it finishes");
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      requestAdmission.release();
      await requestWork.drain();

      expect(getActiveGatewayRootWorkCount()).toBe(1);
      runGate.resolve();
      const completion = await admission.completion;
      await runReleased.promise;
      expect(completion).toMatchObject({ status: "ok" });
      expect(subordinateAdmissionClosed).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      runGate.resolve();
      requestAdmission.release();
      await requestWork.drain();
    }
  });

  it.each(["canonical aliases", "config reload", "run failure"])(
    "serializes same-session work: %s",
    async (scenario) => {
      const fail = scenario === "run failure";
      const reload = scenario === "config reload";
      const first = fail ? "shared-session" : "main";
      const second = scenario === "canonical aliases" ? "agent:main:main" : first;
      let config = mainRosterConfig();
      loadConfig.mockImplementation(() => config);
      const gate = createDeferred();
      runAgent.mockImplementationOnce(async () => {
        await gate.promise;
        if (fail) {
          throw new Error("agent exploded");
        }
        return completedRun("first done");
      });
      runAgent.mockResolvedValueOnce(completedRun("second done"));
      dispatchAgentHook("First", { message: "first", sessionKey: first });
      dispatchAgentHook("Second", { message: "second", sessionKey: second });
      await waitForFast(() => expect(runAgent).toHaveBeenCalledTimes(1));
      expect(runAgent.mock.calls[0]?.[0]).toMatchObject({ message: "first", sessionKey: first });
      if (reload) {
        config = { ...mainRosterConfig(), session: { mainKey: "reloaded" } };
      }
      gate.resolve();
      if (fail) {
        await waitForCompletionEvent("Hook First (error): Error: agent exploded");
      }
      await waitForFast(() => expect(runAgent).toHaveBeenCalledTimes(2));
      expect(runAgent.mock.calls[1]?.[0]).toMatchObject({
        message: "second",
        sessionKey: second,
        ...(reload ? { agentId: "main", cfg: config } : {}),
      });
      await waitForIdle();
    },
  );

  it("runs different sessions in parallel", async () => {
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    queueRun(firstGate, "first done");
    queueRun(secondGate, "second done");

    const firstAdmission = dispatchAgentHook("First", {
      message: "first",
      sessionKey: "agent:main:session-a",
    });
    const secondAdmission = dispatchAgentHook("Second", {
      message: "second",
      sessionKey: "agent:main:session-b",
    });

    try {
      const admissions = await Promise.all([firstAdmission, secondAdmission]);
      expect(admissions).toMatchObject([{ ok: true }, { ok: true }]);
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      expect(runAgent).toHaveBeenCalledTimes(2);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await waitForIdle();
    }
  });

  it("keeps cron admission details behind stable public errors", async () => {
    runAgent.mockResolvedValueOnce({
      status: "error",
      error: 'Session "agent:private:canonical" changed while starting work. Retry.',
      admissionDisposition: "session-conflict",
    });

    const result = await dispatchAgentHook("Conflict");

    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      error: "hook agent run was rejected because the target session changed",
      runId: expect.any(String),
    });
    await waitForCompletionEvent(
      'Hook Conflict (error): Session "agent:private:canonical" changed while starting work. Retry.',
    );
    await waitForIdle();
  });

  it("does not start same-session work after its admission timeout", async () => {
    capturedDispatchAgentHook = undefined;
    createGatewayHooksRequestHandler(buildMinimalParams({ agentStartAdmissionTimeoutMs: 10 }));
    const firstRunStarted = createDeferred();
    const releaseFirstRun = createDeferred();
    queueRun(releaseFirstRun, "first done", firstRunStarted.resolve);

    const firstAdmission = dispatchAgentHook("First", {
      message: "first",
      sessionKey: "shared-session",
    });
    await firstRunStarted.promise;
    await expect(firstAdmission).resolves.toMatchObject({ ok: true });

    const timedOutAdmission = dispatchAgentHook("Second", {
      message: "second",
      sessionKey: "shared-session",
    });
    await expect(timedOutAdmission).resolves.toMatchObject({
      ok: false,
      statusCode: 503,
      error: "hook agent run did not start before admission timeout",
    });
    expect(runAgent).toHaveBeenCalledTimes(1);

    releaseFirstRun.resolve();
    await waitForIdle();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("prefers cron diagnostics for returned hook errors", async () => {
    const diagnosticSummary =
      "automation model override 'anthropic/claude-sonnet-4-6' rejected by agents.defaults.modelPolicy.allow: anthropic/claude-sonnet-4-6";
    runAgent.mockResolvedValueOnce({
      status: "error",
      summary: "generic failure",
      error: "raw failure",
      diagnostics: { summary: diagnosticSummary },
      delivered: false,
    });

    dispatchAgentHook("Model hook", { model: "anthropic/claude-sonnet-4-6" });

    await waitForCompletionEvent(`Hook Model hook (error): ${diagnosticSummary}`);
    const meta = logHooksWarnMock.mock.calls.find(
      ([message, candidate]) =>
        message.startsWith("hook agent run completed") && candidate?.name === "Model hook",
    )?.[1];
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({
      sourcePath: "/hooks/agent",
      runId: expect.any(String),
      jobId: expect.any(String),
      logicalSessionKey: "session-1",
      status: "error",
      model: "anthropic/claude-sonnet-4-6",
      summary: diagnosticSummary,
    });
    expect(meta?.sessionKey).toBeUndefined();
    expect(meta).not.toHaveProperty("consoleMessage");
    expect(logHooksWarnMock).toHaveBeenCalledWith(expect.stringContaining(diagnosticSummary), meta);
    expect(logHooksWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("model=anthropic/claude-sonnet-4-6"),
      meta,
    );
  });
});

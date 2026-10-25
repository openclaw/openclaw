import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeferredHookWake } from "../../cron/service/wake.js";
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

const deferHookWakeMock = vi.fn<DeferredHookWake>();
const captureSessionEventTargetMock = vi.fn(async (agentId: string, sessionKey: string) => ({
  agentId,
  sessionKey,
  sessionId: "captured-session",
  generation: "captured-generation",
}));
const enqueueSessionEventMock = vi.fn((_text: string, _options: Record<string, unknown>) => ({
  accepted: Promise.resolve({ ok: true }),
  settled: Promise.resolve({ status: "completed" }),
}));
const runCronIsolatedAgentTurnMock = vi.fn();
const resolveMainSessionKeyMock = vi.fn(() => "main-session");
const resolveAgentMainSessionKeyMock = vi.fn(
  (params: { cfg?: { session?: { mainKey?: string } }; agentId: string }) =>
    `agent:${params.agentId}:${params.cfg?.session?.mainKey ?? "main"}`,
);
const mainRosterConfig = (): OpenClawConfig => ({
  agents: { entries: { main: {} } },
});
const loadConfigMock = vi.fn(mainRosterConfig);
const logHooksInfoMock = vi.fn();
const logHooksWarnMock = vi.fn();
const validateExplicitMessageAccountSelectionMock = vi.fn(
  ({ accountId }: { accountId?: unknown }) => accountId as string | undefined,
);
const resolveOutboundChannelPluginMock = vi.fn(() => ({ id: "telegram" }));
const resolveChannelDefaultAccountIdMock = vi.fn(() => "default");

// mock-isolation: Observe hook handoff without admitting an unrelated ordinary reply turn.
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: captureSessionEventTargetMock,
  enqueueSessionEventForHost: enqueueSessionEventMock,
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));
vi.mock("../../infra/outbound/message-account-selection.js", () => ({
  validateExplicitMessageAccountSelection: validateExplicitMessageAccountSelectionMock,
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
  resolveAgentMainSessionKey: resolveAgentMainSessionKeyMock,
}));
vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));

import { waitForFast } from "../../../test/helpers/vitest-wait.js";
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

function buildMinimalParams(overrides: { agentStartAdmissionTimeoutMs?: number } = {}) {
  return {
    scheduler: createTestGatewayScheduler("fake-timers"),
    deps: {} as never,
    deferHookWake: deferHookWakeMock,
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

function buildAgentPayload(name: string, agentId?: string) {
  return {
    message: "test message",
    name,
    agentId,
    effectiveAgentId: agentId ?? "main",
    wakeMode: "now" as const,
    sessionKey: "session-1",
    sessionMode: "isolated" as const,
    sourcePath: "/hooks/agent",
    deliver: false,
    channel: "last" as const,
    delivery: { mode: "none" as const },
  };
}

function deliveryPayload(name: string, accountId?: string) {
  return {
    ...buildAgentPayload(name),
    deliver: true,
    channel: "telegram",
    to: "123456",
    accountId,
    delivery: { mode: "announce", channel: "telegram", to: "123456", accountId },
  };
}

const finishedRun = (summary = "done", delivered = false) => ({ status: "ok", summary, delivered });
const waitForRuns = (count: number) =>
  waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(count));
const waitForIdle = () => waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
function dispatchNamed(name: string, sessionKey: string) {
  return dispatchAgentHook({ ...buildAgentPayload(name), message: name.toLowerCase(), sessionKey });
}
function queueBlockedRun(gate: ReturnType<typeof createDeferred>, summary = "first done") {
  runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
    await gate.promise;
    return finishedRun(summary);
  });
}
function expectFailureNotice(text: string) {
  return waitForFast(() =>
    expect(enqueueSessionEventMock).toHaveBeenCalledWith(
      text,
      expect.objectContaining({ agentId: "main", sessionKey: "agent:main:main", source: "hook" }),
    ),
  );
}

function dispatchAgentHook(payload: unknown): unknown {
  return resolveDispatchAgentHook()(payload);
}

function dispatchWakeHook(payload: unknown, agentId: string): unknown {
  if (!capturedDispatchWakeHook) {
    throw new Error("dispatchWakeHook missing");
  }
  return capturedDispatchWakeHook(payload, agentId);
}

function resolveDispatchAgentHook(): (...args: unknown[]) => unknown {
  if (!capturedDispatchAgentHook) {
    throw new Error("dispatchAgentHook missing");
  }
  return capturedDispatchAgentHook;
}

type HookLogMeta = {
  sourcePath?: string;
  name?: string;
  runId?: string;
  jobId?: string;
  sessionKey?: string;
  logicalSessionKey?: string;
  status?: string;
  model?: string;
  summary?: string;
};

function logWarnMetaFor(prefix: string, predicate?: (meta: HookLogMeta) => boolean): HookLogMeta {
  const call = logHooksWarnMock.mock.calls.find(([actual, meta]) => {
    if (!actual.startsWith(prefix)) {
      return false;
    }
    return predicate ? predicate(meta as HookLogMeta) : true;
  });
  if (!call) {
    throw new Error(`missing warn log: ${prefix}`);
  }
  return call[1] as HookLogMeta;
}

describe("dispatchAgentHook trust handling", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    deferHookWakeMock.mockImplementation(async ({ commitGuard }) => {
      commitGuard();
      return { ok: true, eventOutcome: "queued" };
    });
    loadConfigMock.mockImplementation(mainRosterConfig);
    validateExplicitMessageAccountSelectionMock.mockImplementation(
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
    loadConfigMock.mockReturnValue({
      agents: { entries: { main: {}, hooks: {} } },
      session: { scope: "global" },
    });

    await dispatchWakeHook(
      {
        text: "Mapped wake",
        mode: "next-heartbeat",
        sessionKey: "hook:mapped",
      },
      "hooks",
    );

    expect(deferHookWakeMock).toHaveBeenCalledExactlyOnceWith({
      text: "Mapped wake",
      agentId: "hooks",
      expectedTarget: {
        agentId: "hooks",
        sessionKey: "global",
        sessionId: "captured-session",
        generation: "captured-generation",
      },
      createIfMissing: true,
      commitGuard: expect.any(Function),
    });
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(captureSessionEventTargetMock).toHaveBeenCalledExactlyOnceWith(
      "hooks",
      "global",
      expect.objectContaining({ assertCaptureCurrent: expect.any(Function) }),
    );
  });

  it("keeps the resolved owner when a deferred multi-agent wake omits agentId", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, molty: {} },
      },
    });

    deferHookWakeMock.mockResolvedValueOnce({ ok: true, eventOutcome: "coalesced" });
    const result = await dispatchWakeHook({ text: "Mapped wake", mode: "next-heartbeat" }, "molty");

    expect(result).toEqual({ eventOutcome: "coalesced" });
    expect(resolveAgentMainSessionKeyMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentId: "molty",
    });
    expect(deferHookWakeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Mapped wake",
        agentId: "molty",
        expectedTarget: expect.objectContaining({ sessionKey: "agent:molty:main" }),
      }),
    );
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
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
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      const scope = getPluginRuntimeGatewayRequestScope();
      observed = scope?.resolveGatewayContext?.();
      observedClient = scope?.client;
      observedBroker = getSpawnBroker();
      return finishedRun();
    });
    runWithSpawnBroker(broker, () =>
      createGatewayHooksRequestHandler({
        ...buildMinimalParams(),
        resolveGatewayContext: () => gatewayContext,
      }),
    );

    await withPluginRuntimeGatewayRequestScope({ client: { id: "retired-request" } } as never, () =>
      dispatchAgentHook(buildAgentPayload("Gateway context")),
    );

    expect(observed).toBe(gatewayContext);
    expect(observedClient).toBeUndefined();
    expect(observedBroker).toBe(broker);
    await waitForIdle();
  });

  it.each([false, true])(
    "rejects explicit delivery accounts (removed after queue: %s)",
    async (queued) => {
      const error = 'Unknown account "missing" for channel telegram.';
      if (queued) {
        validateExplicitMessageAccountSelectionMock.mockImplementationOnce(
          ({ accountId }: { accountId?: unknown }) => accountId as string,
        );
      }
      validateExplicitMessageAccountSelectionMock.mockImplementationOnce(() => {
        throw new Error(error);
      });
      expect(await dispatchAgentHook(deliveryPayload("Invalid account", "missing"))).toMatchObject({
        ok: false,
        statusCode: 400,
        error,
        runId: expect.any(String),
      });
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
    },
  );

  it("binds omitted delivery accounts to the channel default", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce(finishedRun("done", true));
    const result = await dispatchAgentHook(deliveryPayload("Default account"));

    expect(result).toMatchObject({ ok: true });
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
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
    runCronIsolatedAgentTurnMock.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        const observeRelease = captureGatewayRootWorkReleaseObserver();
        assert(observeRelease, "hook execution must own root admission");
        observeRelease(() => runReleased.resolve());
        params.onExecutionStarted?.();
        await runGate.promise;
        const signal = getAsyncWorkSignal();
        assert(signal, "hook execution must own its cancellation scope");
        signal.throwIfAborted();
        subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
        return finishedRun();
      },
    );
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

  it("serializes canonical aliases in dispatch order and loads fresh config for queued runs", async () => {
    let currentConfig = mainRosterConfig();
    loadConfigMock.mockImplementation(() => currentConfig);
    const firstGate = createDeferred();
    queueBlockedRun(firstGate);
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce(finishedRun("second done"));
    dispatchNamed("First", "main");
    dispatchNamed("Second", "agent:main:main");
    await waitForRuns(1);
    expect(runCronIsolatedAgentTurnMock.mock.calls[0]?.[0]).toMatchObject({
      message: "first",
      sessionKey: "main",
    });

    currentConfig = { ...mainRosterConfig(), session: { mainKey: "reloaded" } };
    firstGate.resolve();

    await waitForRuns(2);
    expect(runCronIsolatedAgentTurnMock.mock.calls[1]?.[0]).toMatchObject({
      agentId: "main",
      cfg: currentConfig,
      message: "second",
      sessionKey: "agent:main:main",
    });
    await waitForIdle();
  });

  it("runs different sessions in parallel", async () => {
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    for (const gate of [firstGate, secondGate]) {
      runCronIsolatedAgentTurnMock.mockImplementationOnce(
        async (params: { onExecutionStarted?: () => void }) => {
          params.onExecutionStarted?.();
          await gate.promise;
          return finishedRun();
        },
      );
    }
    const firstAdmission = dispatchNamed("First", "agent:main:session-a");
    const secondAdmission = dispatchNamed("Second", "agent:main:session-b");

    try {
      const admissions = await Promise.all([firstAdmission, secondAdmission]);
      expect(admissions).toEqual([
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ ok: true }),
      ]);
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await waitForIdle();
    }
  });

  it("continues a same-session hook queue after a failed run", async () => {
    runCronIsolatedAgentTurnMock.mockRejectedValueOnce(new Error("agent exploded"));
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce(finishedRun("second done"));
    dispatchNamed("First", "shared-session");
    dispatchNamed("Second", "shared-session");
    await expectFailureNotice("Hook First (error): Error: agent exploded");
    await waitForRuns(2);
    expect(runCronIsolatedAgentTurnMock.mock.calls[1]?.[0]).toMatchObject({
      message: "second",
      sessionKey: "shared-session",
    });
    await waitForIdle();
  });

  it("keeps cron admission details behind stable public errors", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "error",
      error: 'Session "agent:private:canonical" changed while starting work. Retry.',
      admissionDisposition: "session-conflict",
    });

    const result = await dispatchAgentHook(buildAgentPayload("Conflict"));

    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      error: "hook agent run was rejected because the target session changed",
      runId: expect.any(String),
    });
    await expectFailureNotice(
      'Hook Conflict (error): Session "agent:private:canonical" changed while starting work. Retry.',
    );
    await waitForIdle();
  });

  it("does not start same-session work after its admission timeout", async () => {
    capturedDispatchAgentHook = undefined;
    createGatewayHooksRequestHandler(buildMinimalParams({ agentStartAdmissionTimeoutMs: 10 }));
    const firstRunStarted = createDeferred();
    const releaseFirstRun = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        firstRunStarted.resolve();
        await releaseFirstRun.promise;
        return finishedRun("first done");
      },
    );

    const firstAdmission = dispatchNamed("First", "shared-session");
    await firstRunStarted.promise;
    await expect(firstAdmission).resolves.toMatchObject({ ok: true });

    const timedOutAdmission = dispatchNamed("Second", "shared-session");
    await expect(timedOutAdmission).resolves.toMatchObject({
      ok: false,
      statusCode: 503,
      error: "hook agent run did not start before admission timeout",
    });
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1);

    releaseFirstRun.resolve();
    await waitForIdle();
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1);
  });

  it("prefers cron diagnostics for returned hook errors", async () => {
    const diagnosticSummary =
      "automation model override 'anthropic/claude-sonnet-4-6' rejected by agents.defaults.modelPolicy.allow: anthropic/claude-sonnet-4-6";
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "error",
      summary: "generic failure",
      error: "raw failure",
      diagnostics: {
        summary: diagnosticSummary,
        entries: [
          {
            ts: 1,
            source: "cron-preflight",
            severity: "error",
            message: diagnosticSummary,
          },
        ],
      },
      delivered: false,
    });

    dispatchAgentHook({
      ...buildAgentPayload("Model hook"),
      model: "anthropic/claude-sonnet-4-6",
    });

    await expectFailureNotice(`Hook Model hook (error): ${diagnosticSummary}`);
    const meta = logWarnMetaFor(
      "hook agent run completed",
      (candidate) => candidate.name === "Model hook",
    );
    expect(meta).toMatchObject({
      sourcePath: "/hooks/agent",
      runId: expect.any(String),
      jobId: expect.any(String),
      logicalSessionKey: "session-1",
      status: "error",
      model: "anthropic/claude-sonnet-4-6",
      summary: diagnosticSummary,
    });
    expect(meta.sessionKey).toBeUndefined();
    expect(meta).not.toHaveProperty("consoleMessage");
    expect(logHooksWarnMock).toHaveBeenCalledWith(expect.stringContaining(diagnosticSummary), meta);
    expect(logHooksWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("model=anthropic/claude-sonnet-4-6"),
      meta,
    );
  });
});

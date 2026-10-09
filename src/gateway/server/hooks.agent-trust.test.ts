/**
 * Hook endpoint trust tests for agent dispatch and gateway network config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { getSpawnBroker, runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../../process/spawn-broker/host.test-support.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";

const enqueueSystemEventMock = vi.fn();
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

vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: enqueueSystemEventMock,
  enqueueSystemEventWithReceipt: (...args: unknown[]) =>
    enqueueSystemEventMock(...args) ? () => true : null,
}));
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

const { createGatewayHooksRequestHandler } = await import("./hooks.js");
const createBroker = useSpawnBrokerTestFixture(afterEach);

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

function expectOwnedSystemEvent(text: string, ownerAgentId: string): void {
  const call = enqueueSystemEventMock.mock.calls.find(([queuedText]) => queuedText === text);
  expect(call?.[1]).toEqual({ sessionKey: `agent:${ownerAgentId}:global` });
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

function buildAgentPayload(name: string, agentId?: string) {
  return {
    message: "test message",
    name,
    agentId,
    effectiveAgentId: agentId ?? "main",
    idempotencyKey: undefined,
    wakeMode: "now" as const,
    sessionKey: "session-1",
    sourcePath: "/hooks/agent",
    deliver: false,
    channel: "last" as const,
    to: undefined,
    delivery: { mode: "none" as const },
    model: undefined,
    thinking: undefined,
    timeoutSeconds: undefined,
    allowUnsafeExternalContent: undefined,
    externalContentSource: undefined,
  };
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

    expectOwnedSystemEvent("Mapped wake", "hooks");
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(captureSessionEventTargetMock).not.toHaveBeenCalled();
  });

  it("keeps the resolved owner when a deferred multi-agent wake omits agentId", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, molty: {} },
      },
    });

    enqueueSystemEventMock.mockReturnValue(false);
    const result = await dispatchWakeHook({ text: "Mapped wake", mode: "next-heartbeat" }, "molty");

    expect(result).toEqual({ eventOutcome: "coalesced" });
    expect(resolveAgentMainSessionKeyMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentId: "molty",
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Mapped wake", {
      sessionKey: "agent:molty:main",
    });
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
      return { status: "ok", summary: "done", delivered: false };
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
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("rejects an invalid explicit delivery account before the agent runner", async () => {
    validateExplicitMessageAccountSelectionMock.mockImplementationOnce(() => {
      throw new Error('Unknown account "missing" for channel telegram.');
    });

    const result = await dispatchAgentHook({
      ...buildAgentPayload("Invalid account"),
      deliver: true,
      channel: "telegram",
      to: "123456",
      accountId: "missing",
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123456",
        accountId: "missing",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      error: 'Unknown account "missing" for channel telegram.',
      runId: expect.any(String),
    });
    expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
  });

  it("binds omitted delivery accounts to the channel default", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "done",
      delivered: true,
    });

    const result = await dispatchAgentHook({
      ...buildAgentPayload("Default account"),
      deliver: true,
      channel: "telegram",
      to: "123456",
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123456",
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({
          delivery: expect.objectContaining({ accountId: "default" }),
        }),
      }),
    );
  });

  it("revalidates an explicit delivery account against queued-run config", async () => {
    validateExplicitMessageAccountSelectionMock
      .mockImplementationOnce(({ accountId }: { accountId?: unknown }) => accountId as string)
      .mockImplementationOnce(() => {
        throw new Error('Unknown account "removed" for channel telegram.');
      });

    const result = await dispatchAgentHook({
      ...buildAgentPayload("Removed account"),
      deliver: true,
      channel: "telegram",
      to: "123456",
      accountId: "removed",
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123456",
        accountId: "removed",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      error: 'Unknown account "removed" for channel telegram.',
      runId: expect.any(String),
    });
    expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
  });

  it("retains detached agent work after the hook request releases admission", async () => {
    let continueRun = () => {};
    let subordinateAdmissionClosed: boolean | undefined;
    const runGate = new Promise<void>((resolve) => {
      continueRun = resolve;
    });
    runCronIsolatedAgentTurnMock.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        await runGate;
        subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
        return { status: "ok", summary: "done", delivered: false };
      },
    );
    const requestAdmission = tryBeginGatewayRootWorkAdmission();
    expect(requestAdmission).not.toBeNull();

    await requestAdmission?.run(async () => {
      const admission = await dispatchAgentHook(buildAgentPayload("Async hook"));
      expect(admission).toMatchObject({ ok: true });
      expect(getActiveGatewayRootWorkCount()).toBe(2);
    });
    requestAdmission?.release();

    expect(getActiveGatewayRootWorkCount()).toBe(1);
    continueRun();
    await waitForFast(() =>
      expect(logHooksInfoMock).toHaveBeenCalledWith(
        expect.stringMatching(/^hook agent run completed /),
        expect.any(Object),
      ),
    );
    expect(subordinateAdmissionClosed).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("serializes canonical aliases for the same session in dispatch order", async () => {
    const dispatch = resolveDispatchAgentHook();
    const firstGate = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      await firstGate.promise;
      return { status: "ok", summary: "first done", delivered: false };
    });
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "second done",
      delivered: false,
    });

    dispatch({
      ...buildAgentPayload("First"),
      message: "first",
      sessionKey: "main",
    });
    dispatch({
      ...buildAgentPayload("Second"),
      message: "second",
      sessionKey: "agent:main:main",
    });

    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1));
    expect(runCronIsolatedAgentTurnMock.mock.calls[0]?.[0]).toMatchObject({
      message: "first",
      sessionKey: "main",
    });

    firstGate.resolve();

    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));
    expect(runCronIsolatedAgentTurnMock.mock.calls[1]?.[0]).toMatchObject({
      message: "second",
      sessionKey: "agent:main:main",
    });
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("runs different sessions in parallel", async () => {
    const dispatch = resolveDispatchAgentHook();
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        await firstGate.promise;
        return { status: "ok", summary: "first done", delivered: false };
      },
    );

    runCronIsolatedAgentTurnMock.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        await secondGate.promise;
        return { status: "ok", summary: "second done", delivered: false };
      },
    );

    const firstAdmission = dispatch({
      ...buildAgentPayload("First"),
      message: "first",
      sessionKey: "agent:main:session-a",
    });
    const secondAdmission = dispatch({
      ...buildAgentPayload("Second"),
      message: "second",
      sessionKey: "agent:main:session-b",
    });

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
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    }
  });

  it("uses fresh config when a queued hook starts after reload", async () => {
    const dispatch = resolveDispatchAgentHook();
    let currentConfig = mainRosterConfig();
    loadConfigMock.mockImplementation(() => currentConfig);
    const firstGate = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      await firstGate.promise;
      return { status: "ok", summary: "first done", delivered: false };
    });
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "second done",
      delivered: false,
    });

    dispatch({ ...buildAgentPayload("First"), message: "first", sessionKey: "main" });
    dispatch({ ...buildAgentPayload("Second"), message: "second", sessionKey: "main" });
    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1));

    currentConfig = { ...mainRosterConfig(), session: { mainKey: "reloaded" } };
    firstGate.resolve();

    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));
    expect(runCronIsolatedAgentTurnMock.mock.calls[1]?.[0]).toMatchObject({
      agentId: "main",
      cfg: currentConfig,
      message: "second",
      sessionKey: "main",
    });
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("continues a same-session hook queue after a failed run", async () => {
    const dispatch = resolveDispatchAgentHook();
    runCronIsolatedAgentTurnMock.mockRejectedValueOnce(new Error("agent exploded"));
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "second done",
      delivered: false,
    });

    dispatch({
      ...buildAgentPayload("First"),
      message: "first",
      sessionKey: "shared-session",
    });
    dispatch({
      ...buildAgentPayload("Second"),
      message: "second",
      sessionKey: "shared-session",
    });

    await waitForFast(() =>
      expect(enqueueSessionEventMock).toHaveBeenCalledWith(
        "Hook First (error): Error: agent exploded",
        expect.objectContaining({ agentId: "main", sessionKey: "agent:main:main", source: "hook" }),
      ),
    );
    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));
    expect(runCronIsolatedAgentTurnMock.mock.calls[1]?.[0]).toMatchObject({
      message: "second",
      sessionKey: "shared-session",
    });
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
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
    await waitForFast(() =>
      expect(enqueueSessionEventMock).toHaveBeenCalledWith(
        'Hook Conflict (error): Session "agent:private:canonical" changed while starting work. Retry.',
        expect.objectContaining({ agentId: "main", sessionKey: "agent:main:main", source: "hook" }),
      ),
    );
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
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
        return { status: "ok", summary: "first done", delivered: false };
      },
    );

    const firstAdmission = dispatchAgentHook({
      ...buildAgentPayload("First"),
      message: "first",
      sessionKey: "shared-session",
    });
    await firstRunStarted.promise;
    await expect(firstAdmission).resolves.toMatchObject({ ok: true });

    const timedOutAdmission = dispatchAgentHook({
      ...buildAgentPayload("Second"),
      message: "second",
      sessionKey: "shared-session",
    });
    await expect(timedOutAdmission).resolves.toMatchObject({
      ok: false,
      statusCode: 503,
      error: "hook agent run did not start before admission timeout",
    });
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1);

    releaseFirstRun.resolve();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
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

    await waitForFast(() =>
      expect(enqueueSessionEventMock).toHaveBeenCalledWith(
        `Hook Model hook (error): ${diagnosticSummary}`,
        expect.objectContaining({ agentId: "main", sessionKey: "agent:main:main", source: "hook" }),
      ),
    );
    const meta = logWarnMetaFor(
      "hook agent run completed",
      (candidate) => candidate.name === "Model hook",
    );
    expect(meta.sourcePath).toBe("/hooks/agent");
    expect(typeof meta.runId).toBe("string");
    expect(typeof meta.jobId).toBe("string");
    expect(meta.logicalSessionKey).toBe("session-1");
    expect(meta.sessionKey).toBeUndefined();
    expect(meta.status).toBe("error");
    expect(meta.model).toBe("anthropic/claude-sonnet-4-6");
    expect(meta.summary).toBe(diagnosticSummary);
    expect(meta).not.toHaveProperty("consoleMessage");
    expect(logHooksWarnMock).toHaveBeenCalledWith(expect.stringContaining(diagnosticSummary), meta);
    expect(logHooksWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("model=anthropic/claude-sonnet-4-6"),
      meta,
    );
  });
});

// Agent method tests cover run/steer/reset/wait behavior, task/subagent state,
// approval followups, lifecycle hooks, and emitted gateway events.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  mocks,
  resetSessionAccessorMocks,
  resolveAgentTestConfig,
} from "./agent.mocks.test-utils.js";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { installInMemoryTaskRegistryRuntime } from "../../test-utils/task-registry-runtime.js";
import { createChatRunState } from "../server-chat-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import {
  setDateOnlyFakeClockActive,
  waitForAcceptedRunDispatch,
  waitForAssertion,
} from "./agent-clock.test-helpers.js";
import { agentIdentityHandlers } from "./agent-identity.js";
import { createAgentTestSessionRowProjection } from "./agent-session-projection.test-support.js";
import { agentHandlers } from "./agent.js";
import { resetSubagentRegistryMocks } from "./agent.subagent-registry.mocks.test-support.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { suspendHandlers } from "./suspend.js";
import type { GatewayRequestContext } from "./types.js";
export {
  flushScheduledDispatchStep,
  setDateOnlyFakeClockActive,
  waitForAssertion,
} from "./agent-clock.test-helpers.js";

export { getAgentTestMocks } from "./agent.mocks.test-utils.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

export const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG.toString("base64")}`;

export const makeContext = (session?: {
  agentId: string;
  row: GatewaySessionRow;
}): GatewayRequestContext => {
  const projection = createAgentTestSessionRowProjection(resolveAgentTestConfig, session);
  return {
    trackExecution: trackAsyncWork,
    dedupe: new Map(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: createChatRunState(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    getRuntimeConfig: () => resolveAgentTestConfig(),
    ...bindSessionRowProjection({}, () => projection),
  } as unknown as GatewayRequestContext;
};

type AgentHandler = NonNullable<typeof agentHandlers.agent>;

export type AgentHandlerArgs = Parameters<AgentHandler>[0];

export type AgentParams = AgentHandlerArgs["params"];

export type AgentCommandCall = Record<string, unknown>;

type AgentIdentityGetHandler = NonNullable<(typeof agentIdentityHandlers)["agent.identity.get"]>;

type AgentIdentityGetHandlerArgs = Parameters<AgentIdentityGetHandler>[0];

type AgentIdentityGetParams = AgentIdentityGetHandlerArgs["params"];

export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export function expectStringFieldContains(
  record: Record<string, unknown>,
  field: string,
  expected: string,
) {
  expect(record[field]).toBeTypeOf("string");
  expect(record[field]).toContain(expected);
}

export function expectSqliteSessionFileMarkerForEntry(entry: Record<string, unknown> | undefined) {
  expect(entry).not.toHaveProperty("sessionFile");
}

export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

export function expectRespondError(
  mock: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  expect(mockCallArg(mock)).toBe(false);
  expect(mockCallArg(mock, 0, 1)).toBeUndefined();
  return expectRecordFields(mockCallArg(mock, 0, 2), expected);
}

export function mockMainSessionEntry(
  entry: Record<string, unknown>,
  cfg: Record<string, unknown> = {},
) {
  mocks.loadSessionEntry.mockReturnValue({
    cfg,
    storePath: mocks.userTurnStorePath ?? "/tmp/sessions.json",
    entry: {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      ...entry,
    },
    canonicalKey: "agent:main:main",
  });
}

export function buildExistingMainStoreEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "existing-session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function setupNewYorkTimeConfig(isoDate: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  setDateOnlyFakeClockActive(true);
  vi.setSystemTime(new Date(isoDate)); // Wed Jan 28, 8:30 PM EST
  mocks.loadConfigReturn = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
      },
    },
  };
}

export function resetTimeConfig() {
  mocks.loadConfigReturn = {};
  setDateOnlyFakeClockActive(false);
  vi.useRealTimers();
}

export function useTestStateDir(root: string): void {
  setTestEnvValue("OPENCLAW_STATE_DIR", root);
}

export async function expectResetCall(expectedMessage: string) {
  const call = await waitForAgentCommandCall();
  expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
  expect(call?.message).toBe(expectedMessage);
  return call;
}

export function primeMainAgentRun(params?: { sessionId?: string; cfg?: Record<string, unknown> }) {
  mockMainSessionEntry(
    { sessionId: params?.sessionId ?? "existing-session-id" },
    params?.cfg ?? {},
  );
  mocks.updateSessionStore.mockResolvedValue(undefined);
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
}

export async function runMainAgent(message: string, idempotencyKey: string) {
  const respond = vi.fn();
  await invokeAgent(
    {
      message,
      agentId: "main",
      sessionKey: "agent:main:main",
      idempotencyKey,
    },
    { respond, reqId: idempotencyKey },
  );
  return respond;
}

export async function runMainAgentAndCaptureEntry(idempotencyKey: string) {
  const loaded = mocks.loadSessionEntry();
  const canonicalKey = loaded?.canonicalKey ?? "agent:main:main";
  const existingEntry = structuredClone(loaded?.entry ?? buildExistingMainStoreEntry());
  let capturedEntry: Record<string, unknown> | undefined;
  mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
    const store: Record<string, unknown> = {
      [canonicalKey]: existingEntry,
    };
    const result = await updater(store);
    capturedEntry = structuredClone(store[canonicalKey]) as Record<string, unknown>;
    return result;
  });
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
  await runMainAgent("hi", idempotencyKey);
  return requireValue(capturedEntry, "updated session entry missing");
}

function readLastAgentCommandCall(): AgentCommandCall | undefined {
  const calls = mocks.agentCommand.mock.calls;
  const call = calls[calls.length - 1];
  return call?.[0] as AgentCommandCall | undefined;
}

export function backendGatewayClient(): AgentHandlerArgs["client"] {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "gateway-client",
        version: "test",
        platform: "test",
        mode: "backend",
      },
      scopes: ["operator.write"],
    },
  } as AgentHandlerArgs["client"];
}

export function cronContinuationGatewayClient(): AgentHandlerArgs["client"] {
  const client = backendGatewayClient();
  if (!client) {
    throw new Error("expected backend gateway client");
  }
  return {
    ...client,
    internal: { ...client.internal, cronRunContinuation: true },
  };
}

export function cronMediaCompletionEvent(): AgentInternalEvent {
  return {
    type: "task_completion",
    source: "image_generation",
    childSessionKey: "image_generate:task-1",
    childSessionId: "task-1",
    announceType: "image generation task",
    taskLabel: "header image",
    status: "ok",
    statusLabel: "completed successfully",
    result: "MEDIA:/tmp/header.png",
    replyInstruction: "Continue the original cron task.",
  };
}

export function setupCronContinuationReleaseFixture() {
  const sessionKey = "agent:main:cron:job-1:run:run-1";
  const entry: SessionEntry = {
    sessionId: "run-1",
    updatedAt: Date.now(),
    lifecycleRevision: "revision-1",
    modelProvider: "openai",
    model: "gpt-5.4",
    cronRunContinuation: {
      lifecycleRevision: "revision-1",
      phase: "ready",
      basePersisted: true,
    },
  };
  mocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    storePath: mocks.userTurnStorePath ?? "/tmp/sessions.json",
    canonicalKey: sessionKey,
    entry,
  });
  return {
    sessionKey,
    store: { [sessionKey]: structuredClone(entry) } as Record<string, SessionEntry>,
  };
}

export async function invokeGatewaySuspendPrepare(
  context: GatewayRequestContext,
  requestId: string,
) {
  const respond = vi.fn();
  await expectDefined(
    suspendHandlers["gateway.suspend.prepare"],
    'suspendHandlers["gateway.suspend.prepare"] test invariant',
  )({
    params: { requestId },
    respond: respond as never,
    context: {
      ...context,
      cron: {
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        getSuspensionBlockerCount: () => 0,
      },
    } as unknown as GatewayRequestContext,
    req: { type: "req", id: requestId, method: "gateway.suspend.prepare" },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

// Operator-write client that is NOT the in-process backend ACP spawn caller:
// a control-UI connection with the same operator.write scope. It can set
// acpTurnSource but owns no replacement `acp` task row, so CLI tracking stays on.
export function operatorWriteGatewayClient(): AgentHandlerArgs["client"] {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "ui",
      },
      scopes: ["operator.write"],
    },
  } as AgentHandlerArgs["client"];
}

export function operatorWriteCliClient(
  scopes: string[] = ["operator.write"],
): NonNullable<AgentHandlerArgs["client"]> {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "cli",
        version: "test",
        platform: "test",
        mode: "cli",
      },
      scopes,
    },
  };
}

export async function waitForAgentCommandCall<
  T extends AgentCommandCall = AgentCommandCall,
>(): Promise<T> {
  await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
  const call = readLastAgentCommandCall();
  if (!call) {
    throw new Error("expected agentCommand call");
  }
  return call as T;
}

export async function waitForAgentCommandCallAfter<T extends AgentCommandCall = AgentCommandCall>(
  commandCallCount: number,
): Promise<T> {
  if (mocks.agentCommand.mock.calls.length <= commandCallCount) {
    await new Promise<void>((resolve) => {
      const onCommand = () => {
        if (mocks.agentCommand.mock.calls.length <= commandCallCount) {
          return;
        }
        mocks.agentCommandListeners.delete(onCommand);
        resolve();
      };
      mocks.agentCommandListeners.add(onCommand);
      onCommand();
    });
  }
  const call = mocks.agentCommand.mock.calls[commandCallCount];
  if (!call) {
    throw new Error(`expected agentCommand call ${commandCallCount}`);
  }
  return call[0] as unknown as T;
}

export function mockSessionResetSuccess(params: {
  reason: "new" | "reset";
  key?: string;
  sessionId?: string;
}) {
  const key = params.key ?? "agent:main:main";
  const sessionId = params.sessionId ?? "reset-session-id";
  mocks.performGatewaySessionReset.mockImplementation(
    async (opts: { key: string; reason: string; commandSource: string }) => {
      expect(opts.key).toBe(key);
      expect(opts.reason).toBe(params.reason);
      expect(opts.commandSource).toBe("gateway:agent");
      return {
        ok: true,
        key,
        entry: { sessionId },
      };
    },
  );
}

export async function invokeAgent(
  params: AgentParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
    client?: AgentHandlerArgs["client"];
    isWebchatConnect?: AgentHandlerArgs["isWebchatConnect"];
    flushDispatch?: boolean;
  },
) {
  const respond = options?.respond ?? vi.fn();
  const context = options?.context ?? makeContext();
  const initialRespondCallCount = respond.mock.calls.length;
  const commandCallCount = mocks.agentCommand.mock.calls.length;
  // Most cases only need to cross the accepted-ack timer; keep tests that own
  // timer semantics on their explicit clock while avoiding a real sleep here.
  const ownsDispatchTimers = options?.flushDispatch !== false && !vi.isFakeTimers();
  if (ownsDispatchTimers) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }
  try {
    await expectDefined(agentHandlers.agent, "agentHandlers.agent test invariant").call(
      agentHandlers,
      {
        params,
        respond: respond as never,
        context,
        req: { type: "req", id: options?.reqId ?? "agent-test-req", method: "agent" },
        client: options?.client ?? null,
        isWebchatConnect: options?.isWebchatConnect ?? (() => false),
      },
    );
    if (options?.flushDispatch !== false) {
      await waitForAcceptedRunDispatch({
        respond,
        initialRespondCallCount,
        hasDispatched: () => mocks.agentCommand.mock.calls.length > commandCallCount,
        // Cancellation can settle the accepted invocation without dispatch or another reply.
        hasTerminalResult: () => {
          const idempotencyKey = params.idempotencyKey;
          if (typeof idempotencyKey !== "string") {
            return false;
          }
          const payload = asOptionalRecord(context.dedupe.get(`agent:${idempotencyKey}`)?.payload);
          return (
            payload?.status === "ok" || payload?.status === "timeout" || payload?.status === "error"
          );
        },
      });
    }
  } finally {
    if (ownsDispatchTimers) {
      vi.useRealTimers();
    }
  }
  return respond;
}

export async function invokeAgentIdentityGet(
  params: AgentIdentityGetParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
    client?: AgentHandlerArgs["client"];
  },
) {
  const respond = options?.respond ?? vi.fn();
  await expectDefined(
    agentIdentityHandlers["agent.identity.get"],
    'agentIdentityHandlers["agent.identity.get"] test invariant',
  )({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: {
      type: "req",
      id: options?.reqId ?? "agent-identity-test-req",
      method: "agent.identity.get",
    },
    client: options?.client ?? null,
    isWebchatConnect: () => false,
  });
  return respond;
}

/** Keep handler tests on the real task lifecycle without paying for SQLite durability. */
export function resetAgentTaskRegistryForTests(): void {
  resetTaskRegistryForTests({ persist: false });
  installInMemoryTaskRegistryRuntime();
}

export function restoreAgentTaskRegistryRuntimeAfterTests(): void {
  resetTaskRegistryForTests({ persist: false });
}

export const describe0AfterEach0 = async () => {
  mocks.userTurnStorePath = undefined;
  // Drain deferred broadcasts before retiring the test-owned row and runtime state.
  await flushPendingSessionsChangedEvents();
  envSnapshot.restore();
  resetDetachedTaskLifecycleRuntimeForTests();
  resetDiagnosticEventsForTest();
  resetAgentTaskRegistryForTests();
  resetSubagentRegistryForTests({ persist: false });
  resetSubagentRegistryMocks();
  mocks.agentCommand.mockReset();
  mocks.updateSessionStore.mockReset().mockResolvedValue(undefined);
  mocks.loadConfigReturn = {};
  mocks.emitGatewaySessionEndPluginHook.mockReset();
  mocks.emitGatewaySessionStartPluginHook.mockReset();
  resetSessionAccessorMocks();
  mocks.resolveExplicitAgentSessionKey.mockReset().mockReturnValue(undefined);
  mocks.resolveAgentExplicitRecipientSession.mockReset().mockResolvedValue({});
  mocks.readAcpSessionMetaAsync.mockReset().mockResolvedValue(undefined);
  mocks.listAgentIds.mockReset().mockReturnValue(["main"]);
  mocks.getChannelPlugin.mockReset();
  mocks.sendDurableMessageBatch.mockReset();
  mocks.resolveSendPolicy.mockReset().mockReturnValue("allow");
  mocks.resolveSessionLifecycleTimestamps
    .mockReset()
    .mockImplementation(
      ({ entry }: { entry?: { sessionStartedAt?: number; lastInteractionAt?: number } }) => ({
        sessionStartedAt: entry?.sessionStartedAt,
        lastInteractionAt: entry?.lastInteractionAt,
      }),
    );
  mocks.lifecycleGeneration = "test-generation";
  setDateOnlyFakeClockActive(false);
  vi.useRealTimers();
};

async function resetIntegrationState() {
  await flushPendingSessionsChangedEvents();
  envSnapshot.restore();
  resetDetachedTaskLifecycleRuntimeForTests();
  resetAgentTaskRegistryForTests();
  resetSubagentRegistryForTests({ persist: false });
  resetSubagentRegistryMocks();
  mocks.agentCommand.mockReset();
  mocks.loadConfigReturn = {};
  mocks.loadSessionEntry.mockReset();
  mocks.updateSessionStore.mockReset();
  resetSessionAccessorMocks();
  mocks.emitGatewaySessionEndPluginHook.mockReset();
  mocks.emitGatewaySessionStartPluginHook.mockReset();
  mocks.getLatestSubagentRunByChildSessionKey.mockReset();
  mocks.replaceSubagentRunAfterSteer.mockReset();
  mocks.resolveExplicitAgentSessionKey.mockReset().mockReturnValue(undefined);
  mocks.readAcpSessionMetaAsync.mockReset().mockResolvedValue(undefined);
  mocks.listAgentIds.mockReset().mockReturnValue(["main"]);
  mocks.getChannelPlugin.mockReset();
  mocks.sendDurableMessageBatch.mockReset();
  mocks.loadVoiceWakeRoutingConfig.mockReset();
  mocks.resolveVoiceWakeRouteByTrigger.mockReset();
  mocks.resolveSendPolicy.mockReset().mockReturnValue("allow");
  mocks.lifecycleGeneration = "test-generation";
  setDateOnlyFakeClockActive(false);
  vi.useRealTimers();
}

export const describe1BeforeEach0 = () => {
  return resetIntegrationState();
};

export const describe1AfterEach1 = () => {
  return resetIntegrationState();
};

export function prime(sessionId = "existing-session-id", cfg: Record<string, unknown> = {}) {
  mockMainSessionEntry({ sessionId }, cfg);
  mocks.updateSessionStore.mockResolvedValue(undefined);
}

import { describe, expect, it, vi } from "vitest";
import { BARE_SESSION_RESET_PROMPT } from "../../auto-reply/reply/session-reset-prompt.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { waitForTerminalGatewayDedupe } from "./agent-wait-dedupe.js";
import { agentHandlers } from "./agent.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  loadGatewaySessionRow: vi.fn(),
  updateSessionStore: vi.fn(),
  agentCommand: vi.fn(),
  registerAgentRunContext: vi.fn(),
  performGatewaySessionReset: vi.fn(),
  getLatestSubagentRunByChildSessionKey: vi.fn(),
  replaceSubagentRunAfterSteer: vi.fn(),
  loadConfigReturn: {} as Record<string, unknown>,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
    loadGatewaySessionRow: mocks.loadGatewaySessionRow,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
    resolveAgentIdFromSessionKey: () => "main",
    resolveExplicitAgentSessionKey: () => undefined,
    resolveAgentMainSessionKey: ({
      cfg,
      agentId,
    }: {
      cfg?: { session?: { mainKey?: string } };
      agentId: string;
    }) => `agent:${agentId}:${cfg?.session?.mainKey ?? "main"}`,
  };
});

vi.mock("../../commands/agent.js", () => ({
  agentCommand: mocks.agentCommand,
  agentCommandFromIngress: mocks.agentCommand,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => mocks.loadConfigReturn,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
}));

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: mocks.registerAgentRunContext,
  onAgentEvent: vi.fn(),
}));

vi.mock("../../agents/subagent-registry-read.js", () => ({
  getLatestSubagentRunByChildSessionKey: mocks.getLatestSubagentRunByChildSessionKey,
}));

vi.mock("../session-subagent-reactivation.runtime.js", () => ({
  replaceSubagentRunAfterSteer: mocks.replaceSubagentRunAfterSteer,
}));

vi.mock("../session-reset-service.js", () => ({
  performGatewaySessionReset: (...args: unknown[]) =>
    (mocks.performGatewaySessionReset as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => "allow",
}));

vi.mock("../../utils/delivery-context.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/delivery-context.js")>(
    "../../utils/delivery-context.js",
  );
  return {
    ...actual,
    normalizeSessionDeliveryFields: () => ({}),
  };
});

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    addChatRun: vi.fn(),
    chatAbortControllers: new Map(),
    logGateway: { info: vi.fn(), error: vi.fn() },
    registerToolEventRecipient: vi.fn(),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
  }) as unknown as GatewayRequestContext;

type AgentHandlerArgs = Parameters<typeof agentHandlers.agent>[0];
type AgentParams = AgentHandlerArgs["params"];

type AgentIdentityGetHandlerArgs = Parameters<(typeof agentHandlers)["agent.identity.get"]>[0];
type AgentIdentityGetParams = AgentIdentityGetHandlerArgs["params"];

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 5) {
  vi.useFakeTimers();
  try {
    let lastError: unknown;
    for (let elapsed = 0; elapsed <= timeoutMs; elapsed += stepMs) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
      }
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(stepMs);
    }
    throw lastError ?? new Error("assertion did not pass in time");
  } finally {
    vi.useRealTimers();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createActiveRun(
  runId: string,
  overrides: Partial<ChatAbortControllerEntry> = {},
): ChatAbortControllerEntry {
  const now = Date.now();
  return {
    kind: overrides.kind ?? "agent",
    controller: overrides.controller ?? new AbortController(),
    sessionId: overrides.sessionId ?? `${runId}-session`,
    sessionKey: overrides.sessionKey ?? "agent:main:main",
    startedAtMs: overrides.startedAtMs ?? now,
    expiresAtMs: overrides.expiresAtMs ?? now + 60_000,
    ownerConnId: overrides.ownerConnId,
    ownerDeviceId: overrides.ownerDeviceId,
  };
}

function mockMainSessionEntry(entry: Record<string, unknown>, cfg: Record<string, unknown> = {}) {
  mocks.loadSessionEntry.mockReturnValue({
    cfg,
    storePath: "/tmp/sessions.json",
    entry: {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      ...entry,
    },
    canonicalKey: "agent:main:main",
  });
}

function captureUpdatedMainEntry() {
  let capturedEntry: Record<string, unknown> | undefined;
  mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
    const store: Record<string, unknown> = {};
    await updater(store);
    capturedEntry = store["agent:main:main"] as Record<string, unknown>;
  });
  return () => capturedEntry;
}

function buildExistingMainStoreEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "existing-session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function runMainAgentAndCaptureEntry(idempotencyKey: string) {
  const getCapturedEntry = captureUpdatedMainEntry();
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
  await runMainAgent("test", idempotencyKey);
  expect(mocks.updateSessionStore).toHaveBeenCalled();
  return getCapturedEntry();
}

function setupNewYorkTimeConfig(isoDate: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoDate)); // Wed Jan 28, 8:30 PM EST
  mocks.agentCommand.mockClear();
  mocks.loadConfigReturn = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
      },
    },
  };
}

function resetTimeConfig() {
  mocks.loadConfigReturn = {};
  vi.useRealTimers();
}

async function expectResetCall(expectedMessage: string) {
  await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
  expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
  const call = readLastAgentCommandCall();
  expect(call?.message).toBe(expectedMessage);
  return call;
}

function primeMainAgentRun(params?: { sessionId?: string; cfg?: Record<string, unknown> }) {
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

async function runMainAgent(message: string, idempotencyKey: string) {
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

function readLastAgentCommandCall():
  | {
      message?: string;
      sessionId?: string;
    }
  | undefined {
  return mocks.agentCommand.mock.calls.at(-1)?.[0] as
    | { message?: string; sessionId?: string }
    | undefined;
}

function mockSessionResetSuccess(params: {
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

async function invokeAgent(
  params: AgentParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
    client?: AgentHandlerArgs["client"];
    isWebchatConnect?: AgentHandlerArgs["isWebchatConnect"];
  },
) {
  const respond = options?.respond ?? vi.fn();
  await agentHandlers.agent({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: { type: "req", id: options?.reqId ?? "agent-test-req", method: "agent" },
    client: options?.client ?? null,
    isWebchatConnect: options?.isWebchatConnect ?? (() => false),
  });
  return respond;
}

async function invokeAgentIdentityGet(
  params: AgentIdentityGetParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
  },
) {
  const respond = options?.respond ?? vi.fn();
  await agentHandlers["agent.identity.get"]({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: {
      type: "req",
      id: options?.reqId ?? "agent-identity-test-req",
      method: "agent.identity.get",
    },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

async function invokeAgentWait(
  params: { runId: string; timeoutMs?: number },
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
  },
) {
  const respond = options?.respond ?? vi.fn();
  await agentHandlers["agent.wait"]({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: {
      type: "req",
      id: options?.reqId ?? "agent-wait-test-req",
      method: "agent.wait",
    },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("gateway agent handler", () => {
  it("preserves ACP metadata from the current stored session entry", async () => {
    const existingAcpMeta = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    };

    mockMainSessionEntry({
      acp: existingAcpMeta,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({ acp: existingAcpMeta }),
      };
      const result = await updater(store);
      capturedEntry = store["agent:main:main"] as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem-acp-meta");

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.acp).toEqual(existingAcpMeta);
  });

  it("forwards provider and model overrides for admin-scoped callers", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override",
      },
      {
        reqId: "test-idem-model-override",
        client: {
          connect: {
            scopes: ["operator.admin"],
          },
        } as AgentHandlerArgs["client"],
      },
    );

    const lastCall = mocks.agentCommand.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    );
  });

  it("rejects provider and model overrides for write-scoped callers", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override-write",
      },
      {
        reqId: "test-idem-model-override-write",
        client: {
          connect: {
            scopes: ["operator.write"],
          },
        } as AgentHandlerArgs["client"],
        respond,
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "provider/model overrides are not authorized for this caller.",
      }),
    );
  });

  it("forwards provider and model overrides when internal override authorization is set", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override-internal",
      },
      {
        reqId: "test-idem-model-override-internal",
        client: {
          connect: {
            scopes: ["operator.write"],
          },
          internal: {
            allowModelOverride: true,
          },
        } as AgentHandlerArgs["client"],
      },
    );

    const lastCall = mocks.agentCommand.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        senderIsOwner: false,
      }),
    );
  });

  it("rejects agent runs when idempotencyKey collides with an active run", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    mocks.updateSessionStore.mockClear();
    mocks.registerAgentRunContext.mockClear();
    const respond = vi.fn();
    const context = makeContext();
    context.chatAbortControllers.set(
      "collision-idem",
      createActiveRun("collision-idem", { sessionKey: "agent:other:main" }),
    );

    await invokeAgent(
      {
        message: "test collision",
        sessionKey: "agent:main:main",
        idempotencyKey: "collision-idem",
      },
      {
        reqId: "collision-idem",
        respond,
        context,
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(context.dedupe.has("agent:collision-idem")).toBe(false);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message:
          'idempotencyKey "collision-idem" already belongs to an active run; use a unique key.',
      }),
    );
  });

  it("rejects colliding /reset before mutating session state", async () => {
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();
    mocks.updateSessionStore.mockClear();
    mocks.registerAgentRunContext.mockClear();
    const respond = vi.fn();
    const context = makeContext();
    context.chatAbortControllers.set(
      "collision-reset",
      createActiveRun("collision-reset", { sessionKey: "agent:other:main" }),
    );

    await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "collision-reset",
      },
      {
        reqId: "collision-reset",
        respond,
        context,
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message:
          'idempotencyKey "collision-reset" already belongs to an active run; use a unique key.',
      }),
    );
  });

  it("returns cached accepted for same runId retries while the first request is preparing", async () => {
    const runId = "run-preparing-retry";
    primeMainAgentRun();
    const context = makeContext();
    const firstRespond = vi.fn();
    const retryRespond = vi.fn();
    const storeDeferred = createDeferred<Record<string, unknown> | undefined>();

    mocks.updateSessionStore.mockImplementationOnce(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      const updated = await updater(store);
      await storeDeferred.promise;
      return updated;
    });

    const firstPromise = invokeAgent(
      {
        message: "prepare",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        reqId: `${runId}-first`,
        respond: firstRespond,
        context,
      },
    );

    await waitForAssertion(() => {
      expect(context.dedupe.get(`agent:${runId}`)?.payload).toEqual(
        expect.objectContaining({
          runId,
          status: "accepted",
        }),
      );
      expect(context.chatAbortControllers.get(runId)?.sessionKey).toBe("agent:main:main");
    });

    await invokeAgent(
      {
        message: "prepare",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        reqId: `${runId}-retry`,
        respond: retryRespond,
        context,
      },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(retryRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId,
        status: "accepted",
      }),
      undefined,
      { cached: true },
    );

    storeDeferred.resolve({
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
    });
    await firstPromise;
  });

  it("records a terminal error if setup fails after a retry already observed accepted", async () => {
    const runId = "run-preparing-reset-failure";
    primeMainAgentRun();
    const context = makeContext();
    const firstRespond = vi.fn();
    const retryRespond = vi.fn();
    const adminClient = {
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
      },
    } as AgentHandlerArgs["client"];
    const resetDeferred = createDeferred<
      | {
          ok: true;
          key: string;
          entry: { sessionId: string };
        }
      | {
          ok: false;
          error: { code: string; message: string };
        }
    >();

    mocks.performGatewaySessionReset.mockImplementationOnce(async () => {
      return await resetDeferred.promise;
    });

    const firstPromise = invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        reqId: `${runId}-first`,
        respond: firstRespond,
        context,
        client: adminClient,
      },
    );

    await waitForAssertion(() => {
      expect(context.dedupe.get(`agent:${runId}`)?.payload).toEqual(
        expect.objectContaining({
          runId,
          status: "accepted",
        }),
      );
      expect(context.chatAbortControllers.get(runId)?.sessionKey).toBe("agent:main:main");
    });

    const waitPromise = waitForTerminalGatewayDedupe({
      dedupe: context.dedupe,
      runId,
      timeoutMs: 1_000,
    });

    await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        reqId: `${runId}-retry`,
        respond: retryRespond,
        context,
        client: adminClient,
      },
    );

    expect(retryRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId,
        status: "accepted",
      }),
      undefined,
      { cached: true },
    );

    resetDeferred.resolve({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "reset failed",
      },
    });
    await firstPromise;

    await expect(waitPromise).resolves.toEqual(
      expect.objectContaining({
        status: "error",
        error: "reset failed",
      }),
    );
    expect(context.dedupe.get(`agent:${runId}`)).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: "reset failed",
        }),
      }),
    );
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(firstRespond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "reset failed",
      }),
    );
    mocks.performGatewaySessionReset.mockClear();
  });

  it("preserves abort-entry grace for timeouts longer than 24 hours", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-28T00:00:00.000Z"));
      const now = Date.now();
      primeMainAgentRun();
      const deferred = createDeferred<{
        payloads: Array<{ text: string }>;
        meta: { durationMs: number };
      }>();
      mocks.agentCommand.mockReturnValue(deferred.promise);
      const respond = vi.fn();
      const context = makeContext();
      const runId = "run-long-timeout";
      const timeoutSeconds = 25 * 60 * 60;

      await invokeAgent(
        {
          message: "test long timeout",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
          timeout: timeoutSeconds,
        },
        {
          reqId: runId,
          respond,
          context,
        },
      );

      expect(context.chatAbortControllers.get(runId)?.expiresAtMs).toBe(
        now + timeoutSeconds * 1_000 + 60_000,
      );

      deferred.resolve({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });
      await waitForAssertion(() => {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            runId,
            status: "ok",
          }),
          undefined,
          { runId },
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a newer abort-controller entry when the original run resolves", async () => {
    primeMainAgentRun();
    const deferred = createDeferred<{
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }>();
    mocks.agentCommand.mockReturnValue(deferred.promise);
    const respond = vi.fn();
    const context = makeContext();

    await invokeAgent(
      {
        message: "test replacement success",
        sessionKey: "agent:main:main",
        idempotencyKey: "run-replacement-success",
      },
      {
        reqId: "run-replacement-success",
        respond,
        context,
      },
    );

    expect(context.chatAbortControllers.has("run-replacement-success")).toBe(true);
    const replacement = createActiveRun("run-replacement-success", {
      sessionId: "replacement-session",
    });
    context.chatAbortControllers.set("run-replacement-success", replacement);
    deferred.resolve({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await waitForAssertion(() => {
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          runId: "run-replacement-success",
          status: "ok",
        }),
        undefined,
        { runId: "run-replacement-success" },
      );
    });
    expect(context.chatAbortControllers.get("run-replacement-success")).toBe(replacement);
  });

  it("preserves a newer abort-controller entry when the original run rejects", async () => {
    primeMainAgentRun();
    const deferred = createDeferred<{
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }>();
    mocks.agentCommand.mockReturnValue(deferred.promise);
    const respond = vi.fn();
    const context = makeContext();

    await invokeAgent(
      {
        message: "test replacement failure",
        sessionKey: "agent:main:main",
        idempotencyKey: "run-replacement-error",
      },
      {
        reqId: "run-replacement-error",
        respond,
        context,
      },
    );

    expect(context.chatAbortControllers.has("run-replacement-error")).toBe(true);
    const replacement = createActiveRun("run-replacement-error", {
      sessionId: "replacement-error-session",
    });
    context.chatAbortControllers.set("run-replacement-error", replacement);
    deferred.reject(new Error("boom"));

    await waitForAssertion(() => {
      expect(respond).toHaveBeenCalledWith(
        false,
        expect.objectContaining({
          runId: "run-replacement-error",
          status: "error",
        }),
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: "Error: boom",
        }),
        expect.objectContaining({
          runId: "run-replacement-error",
        }),
      );
    });
    expect(context.chatAbortControllers.get("run-replacement-error")).toBe(replacement);
  });

  it("rejects subagent runId collisions before remapping follow-up state", async () => {
    const childSessionKey = "agent:main:subagent:late-collision";
    const runId = "run-late-collision";
    const completedRun = {
      runId: "run-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep" as const,
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
      outcome: { status: "ok" as const },
    };
    const context = makeContext();
    const collisionEntry = createActiveRun(runId, {
      sessionId: "collision-session",
      sessionKey: "agent:other:main",
    });
    context.chatAbortControllers.set(runId, collisionEntry);
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(completedRun);
    mocks.loadSessionEntry.mockClear();
    mocks.updateSessionStore.mockClear();
    mocks.replaceSubagentRunAfterSteer.mockClear();
    mocks.agentCommand.mockClear();
    mocks.registerAgentRunContext.mockClear();
    const respond = vi.fn();
    const registerToolEventRecipient = context.registerToolEventRecipient as unknown as ReturnType<
      typeof vi.fn
    >;

    await invokeAgent(
      {
        message: "follow-up",
        sessionKey: childSessionKey,
        idempotencyKey: runId,
      },
      {
        reqId: runId,
        respond,
        context,
        client: {
          connId: "conn-1",
          connect: { caps: ["tool-events"] },
        } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(registerToolEventRecipient).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.get(runId)).toBe(collisionEntry);
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(respond).toHaveBeenNthCalledWith(
      1,
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: `idempotencyKey "${runId}" already belongs to an active run; use a unique key.`,
      }),
    );
  });

  it("rejects main-session runId collisions before mutating session state", async () => {
    const runId = "run-main-late-collision";
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    mocks.updateSessionStore.mockClear();
    mocks.registerAgentRunContext.mockClear();
    const context = makeContext();
    const collisionEntry = createActiveRun(runId, {
      sessionId: "collision-session",
      sessionKey: "agent:other:main",
    });
    context.chatAbortControllers.set(runId, collisionEntry);
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "test main late collision",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        reqId: runId,
        respond,
        context,
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.get(runId)).toBe(collisionEntry);
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(respond).toHaveBeenNthCalledWith(
      1,
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: `idempotencyKey "${runId}" already belongs to an active run; use a unique key.`,
      }),
    );
  });

  it("preserves cliSessionIds from existing session entry", async () => {
    const existingCliSessionIds = { "claude-cli": "abc-123-def" };
    const existingClaudeCliSessionId = "abc-123-def";

    mockMainSessionEntry({
      cliSessionIds: existingCliSessionIds,
      claudeCliSessionId: existingClaudeCliSessionId,
    });

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem");
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.cliSessionIds).toEqual(existingCliSessionIds);
    expect(capturedEntry?.claudeCliSessionId).toBe(existingClaudeCliSessionId);
  });

  it("reactivates completed subagent sessions and broadcasts send updates", async () => {
    const childSessionKey = "agent:main:subagent:followup";
    const completedRun = {
      runId: "run-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep" as const,
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
      outcome: { status: "ok" as const },
    };

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "sess-followup",
        updatedAt: Date.now(),
      },
      canonicalKey: childSessionKey,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [childSessionKey]: {
          sessionId: "sess-followup",
          updatedAt: Date.now(),
        },
      };
      return await updater(store);
    });
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(completedRun);
    mocks.replaceSubagentRunAfterSteer.mockReturnValueOnce(true);
    mocks.loadGatewaySessionRow.mockReturnValueOnce({
      status: "running",
      startedAt: 123,
      endedAt: undefined,
      runtimeMs: 10,
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    const broadcastToConnIds = vi.fn();
    await invokeAgent(
      {
        message: "follow-up",
        sessionKey: childSessionKey,
        idempotencyKey: "run-new",
      },
      {
        respond,
        context: {
          dedupe: new Map(),
          addChatRun: vi.fn(),
          chatAbortControllers: new Map(),
          logGateway: { info: vi.fn(), error: vi.fn() },
          registerToolEventRecipient: vi.fn(),
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        } as unknown as GatewayRequestContext,
      },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "run-new",
        status: "accepted",
      }),
      undefined,
      { runId: "run-new" },
    );
    expectSubagentFollowupReactivation({
      replaceSubagentRunAfterSteerMock: mocks.replaceSubagentRunAfterSteer,
      broadcastToConnIds,
      completedRun,
      childSessionKey,
    });
  });

  it("does not suppress terminal agent snapshots for active agent runs", async () => {
    const runId = "run-wait-agent-terminal";
    const context = makeContext();
    context.chatAbortControllers.set(runId, createActiveRun(runId, { kind: "agent" }));
    context.dedupe.set(`agent:${runId}`, {
      ts: Date.now(),
      ok: true,
      payload: {
        runId,
        status: "ok",
        startedAt: 10,
        endedAt: 20,
      },
    });

    const respond = await invokeAgentWait(
      {
        runId,
        timeoutMs: 50,
      },
      { context },
    );

    expect(respond).toHaveBeenCalledWith(true, {
      runId,
      status: "ok",
      startedAt: 10,
      endedAt: 20,
      error: undefined,
    });
  });

  it("includes live session setting metadata in agent send events", async () => {
    mockMainSessionEntry({
      sessionId: "sess-main",
      updatedAt: Date.now(),
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          fastMode: true,
          sendPolicy: "deny",
          lastChannel: "telegram",
          lastTo: "-100123",
          lastAccountId: "acct-1",
          lastThreadId: 42,
        }),
      };
      return await updater(store);
    });
    mocks.loadGatewaySessionRow.mockReturnValue({
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      totalTokens: 12,
      status: "running",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const broadcastToConnIds = vi.fn();
    await invokeAgent(
      {
        message: "test",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-live-settings",
      },
      {
        context: {
          dedupe: new Map(),
          addChatRun: vi.fn(),
          chatAbortControllers: new Map(),
          logGateway: { info: vi.fn(), error: vi.fn() },
          registerToolEventRecipient: vi.fn(),
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        } as unknown as GatewayRequestContext,
      },
    );

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        reason: "send",
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        fastMode: true,
        sendPolicy: "deny",
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
        totalTokens: 12,
        status: "running",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  it("injects a timestamp into the message passed to agentCommand", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");

    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "Is it the weekend?",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-timestamp-inject",
      },
      { reqId: "ts-1" },
    );

    // Wait for the async agentCommand call
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());

    const callArgs = mocks.agentCommand.mock.calls[0][0];
    expect(callArgs.message).toBe("[Wed 2026-01-28 20:30 EST] Is it the weekend?");

    resetTimeConfig();
  });

  it.each([
    {
      name: "passes senderIsOwner=false for write-scoped gateway callers",
      scopes: ["operator.write"],
      idempotencyKey: "test-sender-owner-write",
      senderIsOwner: false,
    },
    {
      name: "passes senderIsOwner=true for admin-scoped gateway callers",
      scopes: ["operator.admin"],
      idempotencyKey: "test-sender-owner-admin",
      senderIsOwner: true,
    },
  ])("$name", async ({ scopes, idempotencyKey, senderIsOwner }) => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "owner-tools check",
        sessionKey: "agent:main:main",
        idempotencyKey,
      },
      {
        client: {
          connect: {
            role: "operator",
            scopes,
            client: { id: "test-client", mode: "gateway" },
          },
        } as unknown as AgentHandlerArgs["client"],
      },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(callArgs?.senderIsOwner).toBe(senderIsOwner);
  });

  it("respects explicit bestEffortDeliver=false for main session runs", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "strict delivery",
        agentId: "main",
        sessionKey: "agent:main:main",
        deliver: true,
        replyChannel: "telegram",
        to: "123",
        bestEffortDeliver: false,
        idempotencyKey: "test-strict-delivery",
      },
      { reqId: "strict-1" },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(callArgs.bestEffortDeliver).toBe(false);
  });

  it("rejects public spawned-run metadata fields", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        spawnedBy: "agent:main:subagent:parent",
        workspaceDir: "/tmp/injected",
        idempotencyKey: "workspace-rejected",
      } as AgentParams,
      { reqId: "workspace-rejected-1", respond },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid agent params"),
      }),
    );
  });

  it("only forwards workspaceDir for spawned sessions with stored workspace inheritance", async () => {
    primeMainAgentRun();
    mockMainSessionEntry({
      spawnedBy: "agent:main:subagent:parent",
      spawnedWorkspaceDir: "/tmp/inherited",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          spawnedBy: "agent:main:subagent:parent",
          spawnedWorkspaceDir: "/tmp/inherited",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        idempotencyKey: "workspace-forwarded",
      },
      { reqId: "workspace-forwarded-1" },
    );
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const spawnedCall = mocks.agentCommand.mock.calls.at(-1)?.[0] as { workspaceDir?: string };
    expect(spawnedCall.workspaceDir).toBe("/tmp/inherited");
  });

  it("keeps origin messageChannel as webchat while delivery channel uses last session channel", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "12345",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "12345",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "webchat turn",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-webchat-origin-channel",
      },
      {
        reqId: "webchat-origin-1",
        client: {
          connect: {
            client: { id: "webchat-ui", mode: "webchat" },
          },
        } as AgentHandlerArgs["client"],
        isWebchatConnect: () => true,
      },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as {
      channel?: string;
      messageChannel?: string;
      runContext?: { messageChannel?: string };
    };
    expect(callArgs.channel).toBe("telegram");
    expect(callArgs.messageChannel).toBe("webchat");
    expect(callArgs.runContext?.messageChannel).toBe("webchat");
  });

  it("handles missing cliSessionIds gracefully", async () => {
    mockMainSessionEntry({});

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-2");
    expect(capturedEntry).toBeDefined();
    // Should be undefined, not cause an error
    expect(capturedEntry?.cliSessionIds).toBeUndefined();
    expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
  });

  it("prunes legacy main alias keys when writing a canonical session entry", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {
        session: { mainKey: "work" },
        agents: { list: [{ id: "main", default: true }] },
      },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:work",
    });

    let capturedStore: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:work": { sessionId: "existing-session-id", updatedAt: 10 },
        "agent:main:MAIN": { sessionId: "legacy-session-id", updatedAt: 5 },
      };
      await updater(store);
      capturedStore = store;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "test",
        agentId: "main",
        sessionKey: "main",
        idempotencyKey: "test-idem-alias-prune",
      },
      { reqId: "3" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedStore).toBeDefined();
    expect(capturedStore?.["agent:main:work"]).toBeDefined();
    expect(capturedStore?.["agent:main:MAIN"]).toBeUndefined();
  });

  it("handles bare /new by resetting the same session and sending reset greeting prompt", async () => {
    mockSessionResetSuccess({ reason: "new" });

    primeMainAgentRun({ sessionId: "reset-session-id" });

    await invokeAgent(
      {
        message: "/new",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-new",
      },
      {
        reqId: "4",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalled());
    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    const call = readLastAgentCommandCall();
    // Message is now dynamically built with current date — check key substrings
    expect(call?.message).toContain("Run your Session Startup sequence");
    expect(call?.message).toContain("Current time:");
    expect(call?.message).not.toBe(BARE_SESSION_RESET_PROMPT);
    expect(call?.sessionId).toBe("reset-session-id");
  });

  it("uses /reset suffix as the post-reset message and still injects timestamp", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    mockSessionResetSuccess({ reason: "reset" });
    mocks.performGatewaySessionReset.mockClear();
    primeMainAgentRun({
      sessionId: "reset-session-id",
      cfg: mocks.loadConfigReturn,
    });

    await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-reset-suffix",
      },
      {
        reqId: "4b",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    const call = await expectResetCall("[Wed 2026-01-28 20:30 EST] check status");
    expect(call?.sessionId).toBe("reset-session-id");

    resetTimeConfig();
  });

  it("rejects malformed agent session keys early in agent handler", async () => {
    mocks.agentCommand.mockClear();
    const respond = await invokeAgent(
      {
        message: "test",
        sessionKey: "agent:main",
        idempotencyKey: "test-malformed-session-key",
      },
      { reqId: "4" },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed session key"),
      }),
    );
  });

  it("rejects /reset for write-scoped gateway callers", async () => {
    mockMainSessionEntry({ sessionId: "existing-session-id" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-reset-write-scope",
      },
      {
        reqId: "4c",
        client: { connect: { scopes: ["operator.write"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "missing scope: operator.admin",
      }),
    );
  });

  it("rejects malformed session keys in agent.identity.get", async () => {
    const respond = await invokeAgentIdentityGet(
      {
        sessionKey: "agent:main",
      },
      { reqId: "5" },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed session key"),
      }),
    );
  });
});

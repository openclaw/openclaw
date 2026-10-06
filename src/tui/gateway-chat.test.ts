import assert from "node:assert/strict";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  type HelloOk,
  validateSessionsDescribeParams,
  validateSessionsListParams,
} from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import { ChatLog } from "./components/chat-log.js";
import { withGatewayChatConnection } from "./gateway-chat.test-support.js";
import type { TuiEvent, TuiSessionDescription, TuiSessionList } from "./tui-backend.js";
import {
  createTuiCommandHandlersHarness,
  firstMockArg,
  flushAsyncSelect,
} from "./tui-command-handlers-test-support.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import { makeTuiState } from "./tui-event-test-support.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTui,
  makeTuiSessionList,
} from "./tui-session-actions-test-support.js";
import type { ChatEvent, TuiHistoryLoadResult } from "./tui-types.js";

const { GatewayChatClient } = await import("./gateway-chat.js");
const { GatewayClient, GatewayClientRequestError } = await import("../gateway/client.js");

function createClient() {
  return new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
}

function mockRequest(response?: unknown) {
  return vi.spyOn(GatewayClient.prototype, "request").mockResolvedValue(response);
}

function hello(
  methods: string[] = [],
  scopes = ["operator.admin"],
  capabilities?: string[],
): HelloOk {
  return {
    type: "hello-ok",
    protocol: 3,
    server: { version: "test", connId: "catalog-test" },
    features: { methods, events: [], capabilities },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "operator", scopes },
    policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
  };
}

function legacyParameterError(method: string, parameter: string) {
  return new GatewayClientRequestError({
    code: "INVALID_REQUEST",
    message: `invalid ${method} params: at root: unexpected property '${parameter}'`,
  });
}

async function captureClient(request: (method: string, params?: unknown) => Promise<unknown>) {
  const callbacks: GatewayClientOptions[] = [];
  vi.resetModules();
  vi.doMock("../gateway/client.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../gateway/client.js")>()),
    GatewayClient: class {
      request = request;
      constructor(options: GatewayClientOptions) {
        callbacks.push(options);
      }
    },
  }));
  onTestFinished(() => {
    vi.doUnmock("../gateway/client.js");
    vi.resetModules();
  });
  const { GatewayChatClient: Client } = await import("./gateway-chat.js");
  return { Client, callbacks };
}

describe("GatewayChatClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves availability from the published model catalog", async () => {
    const models = [
      {
        provider: "fixture",
        id: "waiting",
        name: "Waiting",
        available: false,
        unavailableReason: "cooldown",
      },
      { provider: "fixture", id: "unknown", name: "Unknown" },
    ];
    const request = mockRequest({ models });
    const client = createClient();
    client.hello = hello(["models.list"], undefined, [GATEWAY_SERVER_CAPS.PUBLISHED_MODEL_CATALOG]);
    expect(await client.listModels({ agentId: "work" })).toEqual(models);
    expect(request).toHaveBeenCalledExactlyOnceWith("models.list", {
      agentId: "work",
      includeDetails: true,
    });
  });

  it("retains agent-scoped choices during a held refresh but cannot republish after stop", async () => {
    const models = [{ provider: "fixture", id: "known", name: "Known" }];
    const held = createDeferred<{ models: typeof models }>();
    mockRequest().mockResolvedValueOnce({ models }).mockReturnValueOnce(held.promise);
    const client = createClient();
    try {
      await client.listModels({ agentId: "work" });
      const refresh = client.listModels({ agentId: "work" });
      const sharedRefresh = client.listModels({ agentId: "work" });
      expect(client.getKnownModels({ agentId: "work" })).toEqual(models);
      expect(client.getKnownModels({ agentId: "main" })).toBeUndefined();
      await client.stop();
      held.resolve({ models: [{ provider: "fixture", id: "obsolete", name: "Obsolete" }] });
      await Promise.all([refresh, sharedRefresh]);
      expect(client.getKnownModels({ agentId: "work" })).toBeUndefined();
    } finally {
      held.resolve({ models });
    }
  });

  it("keeps rows through sign-in and restores the highlighted model after policy retirement", async () => {
    const models = ["first", "current", "highlighted"].map((id) => ({
      provider: "fixture",
      id,
      name: id,
    }));
    const held = createDeferred<{ models: typeof models }>();
    const request = vi.fn().mockResolvedValueOnce({ models }).mockReturnValue(held.promise);
    const { Client, callbacks } = await captureClient(request);
    const client = new Client({ url: "ws://127.0.0.1:18789", token: "test-token" });
    const onEvent = callbacks[0]?.onEvent;
    assert(onEvent);
    try {
      await client.listModels({ agentId: "main" });
      const harness = createTuiCommandHandlersHarness({
        getKnownModels: (opts) => client.getKnownModels(opts),
        listModels: vi.fn((opts) => client.listModels(opts)),
        sessionInfo: { modelProvider: "fixture", model: "current" },
      });
      client.onModelsChanged = harness.client.onModelsChanged;
      await harness.handleCommand("/models");
      const selector = firstMockArg(harness.openOverlay, "openOverlay") as {
        handleInput(data: string): void;
        render(width: number): string[];
      };
      selector.handleInput("\u001b[B");
      selector.handleInput("\u001b[B");
      onEvent({ type: "event", event: "config.changed", payload: {} });
      expect(selector.render(100).join("\n")).not.toContain("Checking models...");
      expect(selector.render(100).join("\n")).toContain("fixture/highlighted");
      onEvent({
        type: "event",
        event: "chat.metadata.changed",
        payload: { modelSelectionChanged: true },
      });
      expect(selector.render(100).join("\n")).toContain("Checking models...");
      held.resolve({ models });
      await client.listModels({ agentId: "main" });
      selector.handleInput("\r");
      await flushAsyncSelect();
      expect(harness.patchSession).toHaveBeenCalledWith({
        key: "agent:main:main",
        model: "fixture/highlighted",
      });
    } finally {
      held.resolve({ models });
    }
  });

  it("waits for gateway transport teardown on stop", async () => {
    const client = createClient();
    const teardown = createDeferred();
    const stopAndWait = vi
      .spyOn(GatewayClient.prototype, "stopAndWait")
      .mockReturnValue(teardown.promise);
    let stopped = false;
    const stopPromise = client.stop().then(() => {
      stopped = true;
    });

    expect(stopAndWait).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    teardown.resolve();
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it("requests TUI operator scopes and forwards one connect failure per socket", async () => {
    const { Client, callbacks } = await captureClient(async () => {
      throw new Error("unexpected request");
    });
    const client = new Client({
      url: "wss://remote.example/rpc",
      deviceAuthScope: "wss://remote.example/rpc",
      sshTunnel: { target: "me@studio", remotePort: 18789 },
      token: "test-token",
      tlsFingerprint: "sha256:11:22:33:44",
      preauthHandshakeTimeoutMs: 30_000,
    });
    const onConnectError = vi.fn();
    const onDisconnected = vi.fn();
    client.onConnectError = onConnectError;
    client.onDisconnected = onDisconnected;
    const connectError = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "pairing required",
      details: { code: "PAIRING_REQUIRED", requestId: "pair-1" },
    });
    const options = callbacks[0];
    assert(options);
    expect(options).toMatchObject({
      clientName: "openclaw-tui",
      mode: "ui",
      scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
      deviceAuthScope: "wss://remote.example/rpc",
      sshTunnel: { target: "me@studio", remotePort: 18789 },
      tlsFingerprint: "sha256:11:22:33:44",
      preauthHandshakeTimeoutMs: 30_000,
      notifyOnStartupRetry: true,
    });
    expect(options).not.toHaveProperty("deviceIdentity");

    options.onConnectError?.(connectError);
    options.onConnectError?.(new Error("duplicate failure for the same socket"));
    options.onClose?.(1008, "pairing required");

    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(connectError);
    expect(connectError.message).toContain("Pairing request sent.");
    expect(connectError.message).toContain("Control UI (Settings -> Devices)");
    expect(connectError.message).toContain("openclaw devices approve --latest");
    expect(connectError.details).toEqual({ code: "PAIRING_REQUIRED", requestId: "pair-1" });
    expect(onDisconnected).not.toHaveBeenCalled();

    const retryError = new Error("retry failed");
    options.onConnectError?.(retryError);
    expect(onConnectError).toHaveBeenNthCalledWith(2, retryError);
    options.onConnectError?.(new Error("duplicate within the retry socket"));
    expect(onConnectError).toHaveBeenCalledTimes(2);
    options.onHelloOk?.(hello());
    await client.waitForReady();
    options.onConnectError?.(retryError);
    expect(onConnectError).toHaveBeenNthCalledWith(3, retryError);

    options.onHelloOk?.(hello());
    onDisconnected.mockClear();
    client.onConnectError = (error) => {
      onConnectError(error);
      client.onConnectError = undefined;
    };
    (
      client as unknown as { notifyUnclosedConnectError: (error: Error) => void }
    ).notifyUnclosedConnectError(new Error("one-shot structured failure"));
    expect(onDisconnected).not.toHaveBeenCalled();

    options.onHelloOk?.(hello());
    onConnectError.mockClear();
    onDisconnected.mockClear();
    client.onConnectError = onConnectError;
    const startupError = new GatewayClientRequestError({
      code: "UNAVAILABLE",
      message: "gateway starting; retry shortly",
      details: { reason: "startup-sidecars" },
      retryable: true,
      retryAfterMs: 250,
    });
    options.onConnectError?.(startupError);
    options.onClose?.(1013, "gateway starting");

    expect(onConnectError).not.toHaveBeenCalled();
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith("gateway starting");

    onDisconnected.mockClear();
    client.onConnectError = undefined;
    options.onConnectError?.(startupError);
    options.onClose?.(1013, "gateway starting");

    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith("gateway starting");
  });

  it("surfaces loopback block-mode start failures through disconnect handler", async () => {
    vi.useFakeTimers();
    // The preceding mock test resets modules; keep client and proxy ownership together.
    const { GatewayChatClient: CurrentGatewayChatClient } = await import("./gateway-chat.js");
    const { startProxy, stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
    const proxyHandle = await startProxy({
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "block",
    });
    const disconnected = createDeferred<string>();
    const onDisconnected = vi.fn(disconnected.resolve);
    const client = new CurrentGatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
    });
    client.onDisconnected = onDisconnected;

    try {
      client.start();
      await vi.advanceTimersByTimeAsync(2);

      const message =
        "proxy: Gateway loopback control-plane connections are blocked by proxy.loopbackMode; " +
        "run openclaw config set proxy.loopbackMode gateway-only to allow local runtime traffic.";
      await expect(disconnected.promise).resolves.toBe(message);
      expect(onDisconnected).toHaveBeenCalledExactlyOnceWith(message);
    } finally {
      await client.stop();
      await stopProxy(proxyHandle);
    }
  });

  it("retries startup-unavailable history only while the backend is active", async () => {
    vi.useFakeTimers();

    const client = createClient();
    const startupError = new GatewayClientRequestError({
      code: "UNAVAILABLE",
      message: "chat.history unavailable during gateway startup",
      details: { method: "chat.history" },
      retryable: true,
      retryAfterMs: 250,
    });
    const request = mockRequest()
      .mockRejectedValueOnce(startupError)
      .mockResolvedValueOnce({ messages: [] });

    const historyPromise = client.loadHistory({ sessionKey: "main", limit: 200 });
    await vi.advanceTimersByTimeAsync(250);

    await expect(historyPromise).resolves.toEqual({ messages: [] });
    expect(request).toHaveBeenCalledTimes(2);

    const baselineTimerCount = vi.getTimerCount();
    request.mockRejectedValueOnce(startupError).mockRejectedValueOnce(startupError);
    const pendingHistory = Promise.all([
      client.loadHistory({ sessionKey: "first" }).catch((error: unknown) => error),
      client.loadHistory({ sessionKey: "second" }).catch((error: unknown) => error),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 2);

    await client.stop();

    expect(vi.getTimerCount()).toBe(baselineTimerCount);
    await expect(pendingHistory).resolves.toEqual([
      expect.objectContaining({ name: "AbortError" }),
      expect.objectContaining({ name: "AbortError" }),
    ]);
    await expect(client.loadHistory({ sessionKey: "stopped" })).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });

  it("passes selected-agent global scope through chat methods", async () => {
    const client = createClient();
    const request = mockRequest({ messages: [] });

    await client.sendChat({
      sessionKey: "global",
      agentId: "work",
      message: "hello",
      runId: "run-global-work",
    });
    await client.loadHistory({ sessionKey: "global", agentId: "work", limit: 50 });
    await client.abortChat({ sessionKey: "global", agentId: "work", runId: "run-global-work" });
    await client.listModels({ agentId: "work" });

    expect(request).toHaveBeenNthCalledWith(1, "chat.send", {
      sessionKey: "global",
      agentId: "work",
      message: "hello",
      thinking: undefined,
      deliver: undefined,
      timeoutMs: undefined,
      idempotencyKey: "run-global-work",
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: "global",
      agentId: "work",
      limit: 50,
    });
    expect(request).toHaveBeenNthCalledWith(3, "chat.abort", {
      sessionKey: "global",
      agentId: "work",
      runId: "run-global-work",
    });
    expect(request).toHaveBeenNthCalledWith(4, "models.list", { agentId: "work" });
  });

  it("retries session aborts without side-run preservation on older Gateways", async () => {
    const client = createClient();
    const request = mockRequest()
      .mockRejectedValueOnce(legacyParameterError("chat.abort", "preserveSideRuns"))
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["run-main"] });

    await expect(client.abortChat({ sessionKey: "main" })).resolves.toEqual({
      ok: true,
      aborted: true,
      runIds: ["run-main"],
    });
    expect(request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: "main",
      preserveSideRuns: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.abort", { sessionKey: "main" });
  });

  it.each([true, false])(
    "retries legacy creation with succeedsParent=%s",
    async (succeedsParent) => {
      const client = createClient();
      const request = mockRequest()
        .mockRejectedValueOnce(legacyParameterError("sessions.create", "succeedsParent"))
        .mockResolvedValueOnce({ ok: true, key: "agent:main:tui-next" });
      const opts = {
        key: "tui-next",
        ...(succeedsParent ? {} : { agentId: "main" }),
        parentSessionKey: "agent:main:main",
        succeedsParent,
      };
      await expect(client.createSession(opts)).resolves.toEqual({
        ok: true,
        key: "agent:main:tui-next",
      });
      expect(request).toHaveBeenNthCalledWith(1, "sessions.create", {
        ...opts,
        emitCommandHooks: true,
      });
      expect(request).toHaveBeenNthCalledWith(
        2,
        "sessions.create",
        succeedsParent
          ? { key: "tui-next", parentSessionKey: "agent:main:main", emitCommandHooks: true }
          : { key: "tui-next", agentId: "main" },
      );
    },
  );

  it("returns the actual chat send ack status from the gateway", async () => {
    const client = createClient();
    mockRequest({ runId: "run-gateway", status: "timeout" });
    await expect(
      client.sendChat({ sessionKey: "main", message: "hello", runId: "run-local" }),
    ).resolves.toEqual({ runId: "run-gateway", status: "timeout" });
  });

  it("lists gateway commands through commands.list", async () => {
    const client = createClient();
    const command = {
      name: "tts",
      textAliases: ["/tts"],
      description: "Text to speech",
      source: "plugin",
      scope: "both",
      acceptsArgs: false,
    };
    const request = mockRequest({ commands: [command] });

    await expect(
      client.listCommands({ agentId: "main", provider: "discord", scope: "text" }),
    ).resolves.toEqual([command]);
    expect(request).toHaveBeenCalledWith("commands.list", {
      agentId: "main",
      provider: "discord",
      scope: "text",
    });
  });

  it("lists and resolves plugin approvals through the gateway", async () => {
    const client = createClient();
    const pending = [{ id: "plugin:skill-1" }];
    const request = mockRequest()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ok: true });

    await expect(client.listPluginApprovals()).resolves.toEqual(pending);
    await expect(client.resolvePluginApproval("plugin:skill-1", "allow-once")).resolves.toEqual({
      ok: true,
    });

    expect(request).toHaveBeenNthCalledWith(1, "plugin.approval.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "plugin.approval.resolve", {
      id: "plugin:skill-1",
      decision: "allow-once",
    });
  });

  it("requests a new non-worktree session even without mode capabilities", async () => {
    const client = createClient();
    const suggestion = {
      id: "task_1",
      title: "Investigate a restarting service",
      prompt: "Inspect the service status and logs.",
      tldr: "The service is unexpectedly restarting.",
      cwd: "/workspace",
      sessionKey: "agent:main:main",
      agentId: "main",
      createdAt: 1_000,
    };
    const request = mockRequest()
      .mockResolvedValueOnce({ suggestions: [suggestion] })
      .mockResolvedValueOnce({ taskId: "task_1", key: "agent:main:task" })
      .mockResolvedValueOnce({ taskId: "task_2", dismissed: true });
    client.hello = hello([
      "taskSuggestions.list",
      "taskSuggestions.accept",
      "taskSuggestions.dismiss",
    ]);

    await expect(client.listTaskSuggestions()).resolves.toEqual([suggestion]);
    await expect(client.acceptTaskSuggestion("task_1")).resolves.toEqual({
      taskId: "task_1",
      key: "agent:main:task",
    });
    await expect(client.dismissTaskSuggestion("task_2")).resolves.toEqual({
      taskId: "task_2",
      dismissed: true,
    });

    expect(request).toHaveBeenNthCalledWith(1, "taskSuggestions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "taskSuggestions.accept", {
      taskId: "task_1",
      mode: "local",
    });
    expect(request).toHaveBeenNthCalledWith(3, "taskSuggestions.dismiss", { taskId: "task_2" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("derives task suggestion actions from negotiated methods and scopes", () => {
    const client = createClient();
    const methods = ["taskSuggestions.accept", "taskSuggestions.dismiss"];
    client.hello = hello(methods, ["operator.write"]);

    expect(client.getTaskSuggestionActionCapabilities()).toEqual({
      canAccept: false,
      canDismiss: true,
    });

    client.hello = hello(methods);
    expect(client.getTaskSuggestionActionCapabilities()).toEqual({
      canAccept: true,
      canDismiss: true,
    });
  });

  it("skips task suggestion refreshes against older gateways", async () => {
    const client = createClient();
    const request = mockRequest();
    client.hello = hello(["chat.history"]);

    await expect(client.listTaskSuggestions()).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("GatewayChatClient session description", () => {
  it("refreshes an exact session behind more than five newer prefix and label matches", async () => {
    const sessionKey = "agent:work:notes";
    const selected = { key: sessionKey, sessionId: "selected-session", model: "selected-model" };
    const rows: TuiSessionList["sessions"] = [
      ...Array.from({ length: 3 }, (_, index) => ({
        key: `${sessionKey}-${index}`,
        sessionId: `prefix-${index}`,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        key: `agent:work:other-${index}`,
        label: `${sessionKey} label ${index}`,
        sessionId: `label-${index}`,
      })),
      selected,
    ];
    const defaults = { model: "default-model", modelProvider: "openai", contextTokens: 16000 };
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        if (method === "sessions.describe" && validateSessionsDescribeParams(params)) {
          return { session: rows.find((row) => row.key === params.key) ?? null };
        }
        if (method === "sessions.list" && validateSessionsListParams(params)) {
          const search = params.search ?? "";
          const matches = rows.filter(
            (row) => row.key.includes(search) || row.label?.includes(search),
          );
          return makeTuiSessionList({
            sessions: matches.slice(params.offset ?? 0, params.limit),
            defaults,
          });
        }
        throw new Error(`Unexpected request: ${method}`);
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      const state = createBaseState({ currentSessionKey: sessionKey, currentAgentId: "work" });
      const { refreshSessionInfo } = createTestSessionActions({ client, state });

      await refreshSessionInfo();

      expect(state.currentSessionId).toBe("selected-session");
      expect(state.sessionInfo).toMatchObject({
        model: "selected-model",
        modelProvider: "openai",
        contextTokens: 16000,
      });
    } finally {
      request.mockRestore();
    }
  });

  it("excludes phantom sessions from exact metadata reads", async () => {
    const session = { key: "agent:work:sessions", sessionId: " " };
    const defaults = { model: "work-default" };
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method) => {
        if (method === "sessions.describe") {
          return { session };
        }
        if (method === "sessions.list") {
          return makeTuiSessionList({ defaults });
        }
        throw new Error(`Unexpected request: ${method}`);
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      await expect(client.describeSession({ sessionKey: session.key })).resolves.toEqual({
        session: null,
        defaults,
      });
      expect(request).toHaveBeenCalledWith(
        "sessions.describe",
        { key: session.key },
        { signal: expect.any(AbortSignal) },
      );
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        { agentId: "work", limit: 1 },
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      request.mockRestore();
    }
  });
});

const metadataSessionKey = "agent:work:notes";
const oldDescription = {
  session: { key: metadataSessionKey, sessionId: "old-session", model: "old-session-model" },
  defaults: { model: "old-default-model", contextTokens: 8192 },
} satisfies TuiSessionDescription;
const currentDescription = {
  session: {
    key: metadataSessionKey,
    sessionId: "current-session",
    model: "current-session-model",
  },
  defaults: { model: "current-default-model", contextTokens: 32768 },
} satisfies TuiSessionDescription;
const oldListing: TuiSessionList = {
  ts: 1,
  path: "old-store",
  count: 0,
  sessions: [],
  defaults: oldDescription.defaults,
};
const currentListing: TuiSessionList = {
  ts: 2,
  path: "current-store",
  count: 0,
  sessions: [],
  defaults: currentDescription.defaults,
};

function metadataHello(connId: string): HelloOk {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.9.4", connId },
    features: {
      methods: ["chat.history", "sessions.describe", "sessions.list"],
      events: [],
      capabilities: [],
    },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
  };
}

describe("GatewayChatClient session description lifetime", () => {
  it("stops a disconnected metadata retry without dispatching on a later connection", async () => {
    const entered = createDeferred();
    const held = createDeferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        entered.resolve();
        return held.promise;
      }
      return oldListing;
    });
    await withGatewayChatConnection(request, async (client, callbacks) => {
      callbacks.onHelloOk?.(metadataHello("old"));
      const description = client.describeSession({ sessionKey: metadataSessionKey });
      const rejected = expect(description).rejects.toMatchObject({ name: "AbortError" });
      await entered.promise;
      callbacks.onClose?.(1001, "reconnecting");
      held.resolve({ session: oldDescription.session });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await client.stop();
      await rejected;
      const completedCalls = request.mock.calls.length;
      callbacks.onHelloOk?.(metadataHello("late"));
      expect(request).toHaveBeenCalledTimes(completedCalls);
      await expect(
        client.describeSession({ sessionKey: metadataSessionKey }),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(request).toHaveBeenCalledTimes(completedCalls);
    });
  });

  it.each([
    { heldMethod: "sessions.describe", reconnect: true, failure: true },
    { heldMethod: "sessions.list", reconnect: true, failure: false },
    { heldMethod: "sessions.list", reconnect: false, failure: true },
  ])(
    "settles $heldMethod metadata (reconnect=$reconnect, failure=$failure)",
    async ({ heldMethod, reconnect, failure }) => {
      const entered = createDeferred();
      const held = createDeferred<unknown>();
      const error = new Error("Metadata request failed");
      let current = !reconnect;
      const response = (method: string) =>
        method === "sessions.describe"
          ? { session: (current ? currentDescription : oldDescription).session }
          : current
            ? currentListing
            : oldListing;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "sessions.describe" && validateSessionsDescribeParams(params)) {
          expect(params).toEqual({ key: metadataSessionKey, agentId: "work" });
        } else if (method === "sessions.list" && validateSessionsListParams(params)) {
          expect(params).toEqual({ agentId: "work", limit: 1 });
        } else {
          throw new Error(`Unexpected metadata request: ${method}`);
        }
        if (method === heldMethod && (!reconnect || !current)) {
          entered.resolve();
          return held.promise;
        }
        return response(method);
      });
      await withGatewayChatConnection(request, async (client, callbacks) => {
        callbacks.onHelloOk?.(metadataHello(current ? "current" : "old"));
        const description = client.describeSession({
          sessionKey: metadataSessionKey,
          agentId: "work",
        });
        const settled = reconnect
          ? expect(description).resolves.toEqual(currentDescription)
          : expect(description).rejects.toBe(error);
        await entered.promise;
        const oldResponse = response(heldMethod);
        if (reconnect) {
          callbacks.onClose?.(1001, "reconnecting");
          current = true;
          callbacks.onHelloOk?.(metadataHello("current"));
        }
        if (failure) {
          held.reject(error);
        } else {
          held.resolve(oldResponse);
        }
        await settled;
        if (!reconnect) {
          expect(request.mock.calls.filter(([method]) => method === heldMethod)).toHaveLength(1);
        }
      });
    },
  );
});

describe("GatewayChatClient streaming", () => {
  it("continues a background stream after session selection and a lagging history response", async () => {
    const selectedKey = "agent:main:b";
    const history = createDeferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method !== "chat.history") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return history.promise;
    });
    await withGatewayChatConnection(request, async (client, callbacks) => {
      const state = makeTuiState({ currentSessionKey: "agent:main:a", currentSessionId: "a" });
      const chatLog = new ChatLog();
      const tui = makeTui();
      const btw = { clear: vi.fn(), showResult: vi.fn() };
      const setActivityStatus = (activity: string) => {
        state.activityStatus = activity;
      };
      let loadHistory: () => Promise<TuiHistoryLoadResult> = async () => ({ loaded: false });
      const handlers = createEventHandlers({
        state,
        chatLog,
        btw,
        tui,
        setActivityStatus,
        updateFooter: vi.fn(),
        loadHistory: () => loadHistory(),
        streamingWatchdogMs: 0,
      });
      const actions = createTestSessionActions({
        client,
        state,
        chatLog,
        btw,
        tui,
        setActivityStatus,
        invalidateRunOwnership: handlers.dispose,
      });
      loadHistory = actions.loadHistory;
      client.onEvent = (event) => {
        if (event.event === "chat") {
          handlers.handleChatEvent(event.payload);
        }
      };
      const emit = (payload: ChatEvent) =>
        callbacks.onEvent?.({ type: "event", event: "chat", payload });
      const delta = { sessionKey: selectedKey, runId: "run-b", state: "delta" as const };
      const render = () => normalizeTestText(chatLog.render(120).join("\n"));
      try {
        emit({
          ...delta,
          seq: 1,
          deltaText: "Hello",
          message: { role: "assistant", content: "Hello" },
        });
        expect(render()).not.toContain("Hello");

        const selecting = actions.setSession(selectedKey);
        expect(request).toHaveBeenCalledWith("chat.history", {
          sessionKey: selectedKey,
          limit: 200,
        });
        emit({ ...delta, seq: 2, deltaText: " world" });
        history.resolve({
          messages: [],
          sessionInfo: { key: selectedKey, sessionId: "b", activeRunIds: ["run-b"] },
          inFlightRun: { runId: "run-b", text: "Hello" },
        });
        await selecting;
        expect(state.activeChatRunId).toBe("run-b");
        expect(render()).toContain("Hello");
        emit({ ...delta, seq: 3, deltaText: "!" });
        expect(render()).toContain("Hello world!");

        emit({ ...delta, seq: 4, deltaText: "", replace: true });
        expect(render()).not.toContain("Hello");
        emit({ ...delta, seq: 5, deltaText: "Rewritten" });
        expect(render()).toContain("Rewritten");
      } finally {
        handlers.dispose();
        chatLog.dispose();
      }
    });
  });

  it.each(["disconnect", "stop"] as const)("retires wire baselines on %s", async (boundary) => {
    await withGatewayChatConnection(
      async () => ({}),
      async (client, callbacks) => {
        const received: TuiEvent[] = [];
        client.onEvent = (event) => received.push(event);
        const delta = { sessionKey: "agent:main:b", runId: "run-b", state: "delta" };
        const emit = (payload: unknown) =>
          callbacks.onEvent?.({ type: "event", event: "chat", payload });
        emit({ ...delta, message: { role: "assistant", content: "Retired" } });
        if (boundary === "disconnect") {
          callbacks.onClose?.(1006, "reconnecting");
        } else {
          await client.stop();
        }
        emit({ ...delta, deltaText: " suffix" });
        expect(received.at(-1)?.payload).toEqual({
          ...delta,
          deltaText: " suffix",
          message: undefined,
        });
      },
    );
  });
});

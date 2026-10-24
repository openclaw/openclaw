import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HelloOk,
  validateSessionsDescribeParams,
  validateSessionsListParams,
} from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createClientTestIdentity } from "../gateway/client.test-support.js";
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
import type { ChatEvent } from "./tui-types.js";

const { GatewayChatClient } = await import("./gateway-chat.js");
const { GatewayClient, GatewayClientRequestError } = await import("../gateway/client.js");
const connection = { url: "ws://127.0.0.1:18789", token: "test-token" };
const model = (id: string, name = id) => ({ provider: "fixture", id, name });
const writeOptions = {
  timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS,
  signal: expect.any(AbortSignal),
  retainSentResultOnAbort: true,
};

function createClient() {
  return new GatewayChatClient(connection);
}

function mockRequest(response?: unknown) {
  return vi.spyOn(GatewayClient.prototype, "request").mockResolvedValue(response);
}

function mockClient(response?: unknown) {
  return { request: mockRequest(response), client: createClient() };
}

function expectRequests(request: { mock: { calls: unknown[][] } }, ...calls: unknown[][]) {
  expect(request.mock.calls).toEqual(calls);
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

function startupError(message: string, details: Record<string, string>) {
  return new GatewayClientRequestError({
    code: "UNAVAILABLE",
    message,
    details,
    retryable: true,
    retryAfterMs: 250,
  });
}

function mockSessions(
  sessions: TuiSessionList["sessions"],
  defaults: TuiSessionDescription["defaults"],
) {
  return vi.spyOn(GatewayClient.prototype, "request").mockImplementation(async (method, params) => {
    if (method === "sessions.describe" && validateSessionsDescribeParams(params)) {
      return { session: sessions.find((row) => row.key === params.key) ?? null };
    }
    if (method === "sessions.list" && validateSessionsListParams(params)) {
      const search = params.search ?? "";
      const matches = sessions.filter(
        (row) => row.key.includes(search) || row.label?.includes(search),
      );
      return makeTuiSessionList({
        sessions: matches.slice(params.offset ?? 0, params.limit),
        defaults,
      });
    }
    throw new Error(`Unexpected request: ${method}`);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GatewayChatClient", () => {
  it.each([true, false])(
    "scopes model catalogs by negotiated session support: %s",
    async (sessionScoped) => {
      const first = { ...model("first", "First"), available: false, unavailableReason: "cooldown" };
      const { request, client } = mockClient({ models: [first] });
      client.hello = hello(["models.list"], undefined, [
        GATEWAY_SERVER_CAPS.PUBLISHED_MODEL_CATALOG,
        ...(sessionScoped ? [GATEWAY_SERVER_CAPS.SESSION_SCOPED_MODEL_CATALOG] : []),
      ]);
      const scope = (suffix: string) => ({ agentId: "work", sessionKey: `agent:work:${suffix}` });
      await client.listModels(scope("first"));
      const params = { agentId: "work", includeDetails: true };
      expectRequests(request, [
        "models.list",
        { ...params, ...(sessionScoped ? { sessionKey: scope("first").sessionKey } : {}) },
      ]);
      expect(client.getKnownModels(scope("first"))?.[0]).toEqual(first);
      if (sessionScoped) {
        request.mockResolvedValueOnce({ models: [model("second", "Second")] });
        await client.listModels(scope("second"));
        expect(request).toHaveBeenLastCalledWith("models.list", {
          ...params,
          sessionKey: scope("second").sessionKey,
        });
        expect(client.getKnownModels(scope("first"))?.[0]).toEqual(first);
      }
      expect(client.getKnownModels(scope("second"))?.[0]?.id).toBe(
        sessionScoped ? "second" : "first",
      );
    },
  );

  it("retains agent-scoped choices during a held refresh but cannot republish after stop", async () => {
    const models = [model("known", "Known")];
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
      held.resolve({ models: [model("obsolete", "Obsolete")] });
      await Promise.all([refresh, sharedRefresh]);
      expect(client.getKnownModels({ agentId: "work" })).toBeUndefined();
    } finally {
      held.resolve({ models });
    }
  });

  it("keeps rows through sign-in and restores the highlighted model after policy retirement", async () => {
    const models = ["first", "current", "highlighted"].map((id) => model(id));
    const held = createDeferred<{ models: typeof models }>();
    const request = vi.fn().mockResolvedValueOnce({ models }).mockReturnValue(held.promise);
    await withGatewayChatConnection(request, async (client, callbacks) => {
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
        const render = () => selector.render(100).join("\n");
        selector.handleInput("\u001b[B");
        selector.handleInput("\u001b[B");
        callbacks.onEvent?.({ type: "event", event: "config.changed", payload: {} });
        expect(render()).not.toContain("Checking models...");
        expect(render()).toContain("fixture/highlighted");
        callbacks.onEvent?.({
          type: "event",
          event: "chat.metadata.changed",
          payload: { modelSelectionChanged: true },
        });
        expect(render()).toContain("Checking models...");
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
  });

  it("waits for gateway transport teardown on stop", async () => {
    const client = createClient();
    const teardown = createDeferred();
    vi.spyOn(GatewayClient.prototype, "stopAndWait").mockReturnValue(teardown.promise);
    let stopped = false;
    const stopPromise = client.stop().then(() => {
      stopped = true;
    });

    expect(stopped).toBe(false);
    teardown.resolve();
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it("requests TUI operator scopes and forwards one connect failure per socket", async () => {
    const remote = {
      url: "wss://remote.example/rpc",
      deviceAuthScope: "wss://remote.example/rpc",
      sshTunnel: { target: "me@studio", remotePort: 18789 },
      token: "test-token",
      tlsFingerprint: "sha256:11:22:33:44",
      preauthHandshakeTimeoutMs: 30_000,
    };
    await withGatewayChatConnection(
      async () => {
        throw new Error("unexpected request");
      },
      async (client, options) => {
        const onConnectError = vi.fn();
        const onDisconnected = vi.fn();
        client.onConnectError = onConnectError;
        client.onDisconnected = onDisconnected;
        const connectError = new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "pairing required",
          details: { code: "PAIRING_REQUIRED", requestId: "pair-1" },
        });
        expect(options).toMatchObject({
          clientName: "openclaw-tui",
          mode: "ui",
          scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
          ...remote,
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
        const unavailable = startupError("gateway starting; retry shortly", {
          reason: "startup-sidecars",
        });
        for (const handler of [onConnectError, undefined]) {
          onDisconnected.mockClear();
          client.onConnectError = handler;
          options.onConnectError?.(unavailable);
          options.onClose?.(1013, "gateway starting");
          expect(onConnectError).not.toHaveBeenCalled();
          expect(onDisconnected).toHaveBeenCalledExactlyOnceWith("gateway starting");
        }
      },
      remote,
    );
  });

  it("surfaces loopback block-mode start failures through disconnect handler", async () => {
    vi.useFakeTimers();
    const identity = await import("../infra/device-identity-async.js");
    vi.spyOn(identity, "loadOrCreateDeviceIdentityAsync").mockResolvedValue(
      createClientTestIdentity("fixture-tui-proxy-device"),
    );
    // The preceding mock test resets modules; keep client and proxy ownership together.
    const { GatewayChatClient: CurrentGatewayChatClient } = await import("./gateway-chat.js");
    const { startProxy, stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
    const proxyHandle = await startProxy({
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "block",
    });
    const disconnected = createDeferred<string>();
    const client = new CurrentGatewayChatClient(connection);
    client.onDisconnected = disconnected.resolve;

    try {
      client.start();
      await vi.advanceTimersByTimeAsync(2);

      await expect(disconnected.promise).resolves.toMatch(
        /Gateway loopback control-plane connections are blocked.*openclaw config set proxy.loopbackMode gateway-only/,
      );
    } finally {
      await client.stop();
      await stopProxy(proxyHandle);
    }
  });

  it("retries startup-unavailable history only while the backend is active", async () => {
    vi.useFakeTimers();

    const client = createClient();
    const unavailable = startupError("chat.history unavailable during gateway startup", {
      method: "chat.history",
    });
    const request = mockRequest()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({ messages: [] });

    const historyPromise = client.loadHistory({ sessionKey: "main", limit: 200 });
    await vi.advanceTimersByTimeAsync(250);

    await expect(historyPromise).resolves.toEqual({ messages: [] });
    const baselineTimerCount = vi.getTimerCount();
    request.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable);
    const pendingHistory = Promise.all([
      client.loadHistory({ sessionKey: "first" }).catch((error: unknown) => error),
      client.loadHistory({ sessionKey: "second" }).catch((error: unknown) => error),
    ]);
    await vi.advanceTimersByTimeAsync(0);
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
    vi.useFakeTimers();
    const { client, request } = mockClient({ messages: [] });
    request.mockResolvedValueOnce({ runId: "run-gateway", status: "timeout" });
    const scope = { sessionKey: "global", agentId: "work" };
    const runId = "run-global-work";
    await expect(client.sendChat({ ...scope, message: "hello", runId })).resolves.toEqual({
      runId: "run-gateway",
      status: "timeout",
    });
    await client.loadHistory({ ...scope, limit: 50 });
    await client.abortChat({ ...scope, runId });
    await client.listModels({ agentId: "work" });

    expectRequests(
      request,
      [
        "chat.send",
        expect.objectContaining({ ...scope, message: "hello", idempotencyKey: runId }),
        writeOptions,
      ],
      ["chat.history", { ...scope, limit: 50 }],
      ["chat.abort", { ...scope, runId }],
      ["models.list", { agentId: "work" }],
    );
  });

  it("retries session aborts without side-run preservation on older Gateways", async () => {
    const { client, request } = mockClient();
    const result = { ok: true, aborted: true, runIds: ["run-main"] };
    request
      .mockRejectedValueOnce(legacyParameterError("chat.abort", "preserveSideRuns"))
      .mockResolvedValueOnce(result);

    await expect(client.abortChat({ sessionKey: "main" })).resolves.toEqual(result);
    expectRequests(
      request,
      ["chat.abort", { sessionKey: "main", preserveSideRuns: true }],
      ["chat.abort", { sessionKey: "main" }],
    );
  });

  it.each([true, false])(
    "retries legacy creation with succeedsParent=%s",
    async (succeedsParent) => {
      vi.useFakeTimers();
      const { client, request } = mockClient();
      const result = { ok: true, key: "agent:main:tui-next" };
      request
        .mockRejectedValueOnce(legacyParameterError("sessions.create", "succeedsParent"))
        .mockResolvedValueOnce(result);
      const opts = {
        key: "tui-next",
        ...(succeedsParent ? {} : { agentId: "main" }),
        parentSessionKey: "agent:main:main",
        succeedsParent,
      };
      await expect(client.createSession(opts)).resolves.toEqual(result);
      expectRequests(
        request,
        ["sessions.create", { ...opts, emitCommandHooks: true }, writeOptions],
        [
          "sessions.create",
          succeedsParent
            ? { key: "tui-next", parentSessionKey: "agent:main:main", emitCommandHooks: true }
            : { key: "tui-next", agentId: "main" },
          writeOptions,
        ],
      );
    },
  );

  it("lists gateway commands through commands.list", async () => {
    const command = {
      name: "tts",
      textAliases: ["/tts"],
      description: "Text to speech",
      source: "plugin",
      scope: "both",
      acceptsArgs: false,
    };
    const { client, request } = mockClient({ commands: [command] });
    const opts = { agentId: "main", provider: "discord", scope: "text" as const };

    await expect(client.listCommands(opts)).resolves.toEqual([command]);
    expect(request).toHaveBeenCalledWith("commands.list", opts);
  });

  it("lists and resolves plugin approvals through the gateway", async () => {
    const { client, request } = mockClient();
    const pending = [{ id: "plugin:skill-1" }];
    request.mockResolvedValueOnce(pending).mockResolvedValueOnce({ ok: true });

    await expect(client.listPluginApprovals()).resolves.toEqual(pending);
    await expect(client.resolvePluginApproval("plugin:skill-1", "allow-once")).resolves.toEqual({
      ok: true,
    });

    expectRequests(
      request,
      ["plugin.approval.list", {}],
      ["plugin.approval.resolve", { id: "plugin:skill-1", decision: "allow-once" }],
    );
  });

  it("requests a new non-worktree session even without mode capabilities", async () => {
    const { client, request } = mockClient();
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
    const accepted = { taskId: "task_1", key: "agent:main:task" };
    const dismissed = { taskId: "task_2", dismissed: true };
    request
      .mockResolvedValueOnce({ suggestions: [suggestion] })
      .mockResolvedValueOnce(accepted)
      .mockResolvedValueOnce(dismissed);
    client.hello = hello([
      "taskSuggestions.list",
      "taskSuggestions.accept",
      "taskSuggestions.dismiss",
    ]);

    await expect(client.listTaskSuggestions()).resolves.toEqual([suggestion]);
    await expect(client.acceptTaskSuggestion("task_1")).resolves.toEqual(accepted);
    await expect(client.dismissTaskSuggestion("task_2")).resolves.toEqual(dismissed);

    expectRequests(
      request,
      ["taskSuggestions.list", {}],
      ["taskSuggestions.accept", { taskId: "task_1", mode: "local" }],
      ["taskSuggestions.dismiss", { taskId: "task_2" }],
    );
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
    mockSessions(rows, defaults);
    const state = createBaseState({ currentSessionKey: sessionKey, currentAgentId: "work" });
    const { refreshSessionInfo } = createTestSessionActions({ client: createClient(), state });
    await refreshSessionInfo();
    expect(state).toMatchObject({
      currentSessionId: "selected-session",
      sessionInfo: { model: "selected-model", modelProvider: "openai", contextTokens: 16000 },
    });
  });

  it("excludes phantom sessions from exact metadata reads", async () => {
    const session = { key: "agent:work:sessions", sessionId: " " };
    const defaults = { model: "work-default" };
    const request = mockSessions([session], defaults);
    await expect(createClient().describeSession({ sessionKey: session.key })).resolves.toEqual({
      session: null,
      defaults,
    });
    expectRequests(
      request,
      ["sessions.describe", { key: session.key }, { signal: expect.any(AbortSignal) }],
      ["sessions.list", { agentId: "work", limit: 1 }, { signal: expect.any(AbortSignal) }],
    );
  });
});

const metadataSessionKey = "agent:work:notes";
function metadataDescription(prefix: string, contextTokens: number): TuiSessionDescription {
  return {
    session: {
      key: metadataSessionKey,
      sessionId: `${prefix}-session`,
      model: `${prefix}-session-model`,
    },
    defaults: { model: `${prefix}-default-model`, contextTokens },
  };
}
const oldDescription = metadataDescription("old", 8192);
const currentDescription = metadataDescription("current", 32768);
const oldListing = makeTuiSessionList({ defaults: oldDescription.defaults });
const currentListing = makeTuiSessionList({ defaults: currentDescription.defaults });

describe("GatewayChatClient session description lifetime", () => {
  it.each([
    { heldMethod: "sessions.describe", transition: "stop", failure: false },
    { heldMethod: "sessions.describe", transition: "reconnect", failure: true },
    { heldMethod: "sessions.list", transition: "reconnect", failure: false },
    { heldMethod: "sessions.list", transition: "none", failure: true },
  ])(
    "settles $heldMethod metadata on $transition (failure=$failure)",
    async ({ heldMethod, transition, failure }) => {
      const entered = createDeferred();
      const held = createDeferred<unknown>();
      const error = new Error("Metadata request failed");
      let current = transition === "none";
      const response = (method: string) =>
        method === "sessions.describe"
          ? { session: (current ? currentDescription : oldDescription).session }
          : current
            ? currentListing
            : oldListing;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "sessions.describe") {
          expect(params).toEqual({ key: metadataSessionKey, agentId: "work" });
        } else if (method === "sessions.list") {
          expect(params).toEqual({ agentId: "work", limit: 1 });
        } else {
          throw new Error(`Unexpected metadata request: ${method}`);
        }
        if (method === heldMethod && (transition === "none" || !current)) {
          entered.resolve();
          return held.promise;
        }
        return response(method);
      });
      await withGatewayChatConnection(request, async (client, callbacks) => {
        callbacks.onHelloOk?.(hello());
        const description = client.describeSession({
          sessionKey: metadataSessionKey,
          agentId: "work",
        });
        const settled =
          transition === "stop"
            ? expect(description).rejects.toMatchObject({ name: "AbortError" })
            : transition === "reconnect"
              ? expect(description).resolves.toEqual(currentDescription)
              : expect(description).rejects.toBe(error);
        await entered.promise;
        const oldResponse = response(heldMethod);
        if (transition !== "none") {
          callbacks.onClose?.(1001, "reconnecting");
          if (transition === "reconnect") {
            current = true;
            callbacks.onHelloOk?.(hello());
          }
        }
        if (failure) {
          held.reject(error);
        } else {
          held.resolve(oldResponse);
        }
        if (transition === "stop") {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          await client.stop();
        }
        await settled;
        if (transition === "none") {
          expect(request.mock.calls.filter(([method]) => method === heldMethod)).toHaveLength(1);
        } else if (transition === "stop") {
          const completedCalls = request.mock.calls.length;
          callbacks.onHelloOk?.(hello());
          expect(request).toHaveBeenCalledTimes(completedCalls);
          await expect(
            client.describeSession({ sessionKey: metadataSessionKey }),
          ).rejects.toMatchObject({ name: "AbortError" });
          expect(request).toHaveBeenCalledTimes(completedCalls);
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
      const view = { state, chatLog, btw, tui, setActivityStatus };
      const actions = createTestSessionActions({
        client,
        ...view,
        invalidateRunOwnership: () => handlers.dispose(),
      });
      const handlers = createEventHandlers({
        ...view,
        updateFooter: vi.fn(),
        loadHistory: actions.loadHistory,
        streamingWatchdogMs: 0,
      });
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

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import { serveOpenClawChannelMcp } from "./channel-server.js";
import type { QueueEvent, SessionMessagePayload } from "./channel-shared.js";

const transportState = vi.hoisted((): { next?: InMemoryTransport } => ({}));
// mock-isolation: Channel fixtures read empty config without starting a config owner.
vi.mock("../config/config.js", () => ({
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  StdioServerTransport: vi.fn(function () {
    return transportState.next!;
  }),
}));

const startup = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }));
// mock-isolation: Startup owns endpoint facts and hello delivery without real Gateway IO.
vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: vi.fn<typeof resolveGatewayClientBootstrap>(async () => ({
    url: "wss://127.0.0.1:18789",
    urlSource: "local loopback",
    connectionDetails: {
      url: "wss://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: wss://127.0.0.1:18789",
    },
    tlsFingerprint: "sha256:local",
    auth: { token: undefined, password: undefined },
  })),
}));
// mock-isolation: Capture startup callbacks without opening a real Gateway connection.
vi.mock("../gateway/client.js", () => ({
  GatewayClient: class {
    constructor(options: Record<string, unknown>) {
      startup.options = options;
    }
    start(): void {}
    async request(): Promise<void> {}
    async stopAndWait(): Promise<void> {}
  },
}));
// mock-isolation: Startup ordering uses explicit hello delivery, not real event-loop timing.
vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: vi.fn(async (client: { start: () => void }) => {
    client.start();
    return { ready: true, aborted: false, elapsedMs: 0, maxDriftMs: 0, checks: 1 };
  }),
}));
// mock-isolation: The bridge fixture needs scope constants without loading plugin policy state.
vi.mock("../gateway/method-scopes.js", () => ({
  APPROVALS_SCOPE: "operator.approvals",
  READ_SCOPE: "operator.read",
  WRITE_SCOPE: "operator.write",
}));

const route = { channel: "telegram", to: "-100123", accountId: "acct-1" };
const sessionKey = "agent:main:main";
const inlineImage = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "abc" },
};
const resources: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function connectMcpWithoutGateway() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  transportState.next = serverTransport;
  const started = createDeferredCore<BridgeInternals>();
  const startSpy = vi
    .spyOn(OpenClawChannelBridge.prototype, "start")
    .mockImplementation(async function (this: OpenClawChannelBridge) {
      started.resolve(this as unknown as BridgeInternals);
    });
  const serving = serveOpenClawChannelMcp({ claudeChannelMode: "off" });
  void serving.catch(started.reject);
  const bridge = await started.promise;
  startSpy.mockRestore();
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  const mcp = {
    client,
    bridge,
    receive: (payload: SessionMessagePayload) => bridge.handleSessionMessageEvent(payload),
    call: (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      await serverTransport.close();
      await serving;
    },
  };
  resources.push(mcp);
  return mcp;
}

function attachReadyGateway(bridge: BridgeInternals, responses: Record<string, unknown>) {
  const gatewayRequest = vi.fn(async (method: string) => {
    if (!(method in responses)) {
      throw new Error(`unexpected gateway method ${method}`);
    }
    return responses[method];
  });
  bridge.gateway = {
    request: gatewayRequest,
    stopAndWait: async () => {},
  };
  vi.spyOn(bridge, "waitUntilReady").mockResolvedValue();
  return gatewayRequest;
}

describe("openclaw channel mcp server", () => {
  test("preserves primary content, fallback routes and described reply routing", async () => {
    const mcp = await connectMcpWithoutGateway();
    const fallback = { to: "+15551230000", accountId: "two", threadId: 42 };
    const preview = "Use `[[reply_to_current]]` literally.";
    const session = {
      key: sessionKey,
      deliveryContext: { ...route, threadId: 42 },
      lastMessagePreview: preview,
    };
    const gateway = attachReadyGateway(mcp.bridge, {
      "sessions.list": {
        sessions: [session, { key: "fallback", channel: "imessage", deliveryContext: fallback }],
      },
      "sessions.describe": { session },
      send: { ok: true },
    });
    const conversations = await mcp.call("conversations_list");
    const text = (conversations as { content: { text: string }[] }).content[0]?.text;
    expect(text).toContain(`"sessionKey": "${sessionKey}"`);
    expect(text).toContain(preview);
    expect(conversations).toHaveProperty("structuredContent.conversations", [
      expect.objectContaining({ sessionKey, ...route, threadId: 42 }),
      expect.objectContaining({ sessionKey: "fallback", channel: "imessage", ...fallback }),
    ]);
    await mcp.call("messages_send", { session_key: sessionKey, text: "reply from mcp" });
    expect(gateway).toHaveBeenCalledWith("sessions.describe", {
      key: sessionKey,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    expect(gateway).toHaveBeenLastCalledWith("send", {
      ...route,
      threadId: "42",
      sessionKey,
      message: "reply from mcp",
      idempotencyKey: expect.any(String),
    });
  });

  test("merges inline and canonical media without scanning recent history", async () => {
    const mcp = await connectMcpWithoutGateway();
    const media = { url: "media://inbound/photo.png", contentType: "image/png" };
    const gatewayRequest = attachReadyGateway(mcp.bridge, {
      "chat.message.get": {
        ok: true,
        message: {
          content: [{ type: "text", text: "image" }, inlineImage],
          __openclaw: { media: [media] },
        },
      },
    });
    const result = await mcp.call("attachments_fetch", {
      session_key: "agent:main:main",
      message_id: "media-1",
    });
    expect(result.structuredContent).toHaveProperty("attachments", [
      inlineImage,
      { type: "openclaw_media", media: { ...media, kind: "image", transcribed: false } },
    ]);
    expect(gatewayRequest).toHaveBeenCalledWith("chat.message.get", {
      sessionKey: "agent:main:main",
      messageId: "media-1",
    });
  });

  test("rejects oversized limits and timeouts at the MCP input boundary", async () => {
    const mcp = await connectMcpWithoutGateway();
    attachReadyGateway(mcp.bridge, {});
    for (const request of [
      { name: "conversations_list", arguments: { limit: 501 } },
      { name: "messages_read", arguments: { session_key: "agent:main:main", limit: 201 } },
      { name: "events_poll", arguments: { limit: 201 } },
      { name: "events_wait", arguments: { timeout_ms: 3_000_000_000 } },
    ]) {
      const result = await mcp.client.callTool(request);
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("Input validation error") }],
      });
    }
  });

  test("reports cursor gaps and wakes filtered waits on eviction", async () => {
    const mcp = await connectMcpWithoutGateway();
    const pendingFilteredWait = mcp.call("events_wait", {
      after_cursor: 0,
      session_key: "filtered",
      timeout_ms: 300_000,
    });
    await mcp.call("events_poll", { after_cursor: 0, session_key: "filtered" });
    for (let index = 1; index <= 1_001; index += 1) {
      await mcp.receive({
        sessionKey,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
        messageId: "msg-2",
        messageSeq: index,
        message: { role: "user", content: [{ type: "text", text: `event ${index}` }] },
      });
    }

    const filteredWait = await Promise.race([
      pendingFilteredWait,
      new Promise<undefined>((resolve) => {
        setImmediate(() => resolve(undefined));
      }),
    ]);
    const gap = { requested_after_cursor: 0, oldest_available_cursor: 2 };
    expect(filteredWait?.structuredContent).toEqual({
      event: null,
      gap,
    });

    const polled = await mcp.call("events_poll", { after_cursor: 0, limit: 1 });
    expect(polled.structuredContent).toMatchObject({
      gap,
      next_cursor: 2,
    });

    const filteredPoll = await mcp.call("events_poll", {
      after_cursor: 0,
      session_key: "filtered",
    });
    expect(filteredPoll.structuredContent).toEqual({
      events: [],
      gap,
      next_cursor: 1,
    });

    const waited = await mcp.call("events_wait", { after_cursor: 0, timeout_ms: 250 });
    expect(waited.structuredContent).toMatchObject({
      gap,
      event: { cursor: 2 },
    });
  });

  test("cancels an events_wait bridge waiter through the MCP request signal", async () => {
    vi.useFakeTimers();
    const mcp = await connectMcpWithoutGateway();
    const timerBaseline = vi.getTimerCount();
    const controller = new AbortController();
    const waiting = mcp.client.callTool(
      { name: "events_wait", arguments: { after_cursor: 0, timeout_ms: 300_000 } },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(timerBaseline));
    controller.abort("client cancelled");
    await expect(waiting).rejects.toThrow();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(timerBaseline));
  });
});

const ONE_MINUTE_MS = 60 * 1_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const SWEEP_INTERVAL_MS = 5 * ONE_MINUTE_MS;

type BridgeInternals = Pick<OpenClawChannelBridge, keyof OpenClawChannelBridge> & {
  gateway: { request: ReturnType<typeof vi.fn>; stopAndWait: () => Promise<void> };
  queue: QueueEvent[];
  pendingClaudePermissions: Map<string, unknown>;
  pendingApprovals: Map<string, unknown>;
  handleGatewayEvent: (event: GatewayEvent) => Promise<void>;
  dispatchGatewayEvent: (event: GatewayEvent) => Promise<void>;
  handleSessionMessageEvent: (payload: SessionMessagePayload) => Promise<void>;
  server: { server: { notification: (n: unknown) => Promise<void> } } | null;
};
type GatewayEvent = { event: string; payload?: Record<string, unknown> };

let subject: BridgeInternals;
const permissionRequest = {
  requestId: "abcde",
  toolName: "Bash",
  description: "run npm test",
  inputPreview: "{}",
};

function makeBridge(verbose = false): BridgeInternals {
  const bridge = new OpenClawChannelBridge(
    {},
    { claudeChannelMode: "off", verbose },
  ) as unknown as BridgeInternals;
  resources.push(bridge);
  return bridge;
}

function permissionReply(senderIsOwner = true, role = "user") {
  return {
    sessionKey: "agent:main:telegram:group:-100123",
    senderIsOwner,
    message: { role, content: [{ type: "text", text: "yes abcde" }] },
  };
}

function expectDrained(bridge: BridgeInternals) {
  expect(bridge.pendingClaudePermissions.size).toBe(0);
  expect(bridge.pendingApprovals.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

function requestApproval(bridge: BridgeInternals, payload: Record<string, unknown>, kind = "exec") {
  return bridge.handleGatewayEvent({ event: `${kind}.approval.requested`, payload });
}

test("passes resolved TLS identity and waits for Gateway hello before completing startup", async () => {
  const bridge = makeBridge();
  const onStarted = vi.fn();
  const started = bridge.start().then(onStarted);
  await vi.waitFor(() => expect(startup.options).not.toBeNull());
  expect(onStarted).not.toHaveBeenCalled();
  expect(startup.options).toMatchObject({ tlsFingerprint: "sha256:local" });
  expect(startup.options?.notifyOnStartupRetry).not.toBe(true);
  const onHelloOk = startup.options?.onHelloOk;
  if (typeof onHelloOk !== "function") {
    throw new Error("Expected Gateway hello callback");
  }
  onHelloOk();
  await expect(started).resolves.toBeUndefined();
});

describe("OpenClawChannelBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    subject = makeBridge();
  });
  test.each([
    { name: "non-owner", senderIsOwner: false, role: "user" },
    { name: "missing owner metadata", senderIsOwner: undefined, role: "user" },
    { name: "assistant message", senderIsOwner: true, role: "assistant" },
  ])("does not resolve a pending permission from a $name reply", async (reply) => {
    const notification = vi.fn(async () => undefined);
    subject.server = { server: { notification } };
    await subject.handleClaudePermissionRequest(permissionRequest);

    await subject.handleSessionMessageEvent({
      ...permissionReply(true, reply.role),
      senderIsOwner: reply.senderIsOwner,
    });

    expect(notification).not.toHaveBeenCalled();
    expect(subject.pendingClaudePermissions.has("abcde")).toBe(true);
    expect(subject.queue.at(-1)).toMatchObject({ type: "message", text: "yes abcde" });
  });

  test("keeps a permission retryable until its notification is delivered", async () => {
    const notification = vi
      .fn<(notification: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce(undefined);
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    subject.server = { server: { notification } };
    const reply = permissionReply();
    await subject.handleClaudePermissionRequest(permissionRequest);

    await subject.handleSessionMessageEvent(reply);
    await subject.handleSessionMessageEvent(reply);
    expect(notification).toHaveBeenCalledTimes(2);
    expect(writeSpy.mock.calls).toEqual([
      ["openclaw mcp: notification notifications/claude/channel/permission failed\n"],
    ]);

    await subject.handleSessionMessageEvent(reply);
    expect(notification).toHaveBeenCalledTimes(2);
  });
  test.each([
    ["permission", ONE_HOUR_MS, {}],
    ["plugin", 30 * ONE_MINUTE_MS, { createdAtMs: 0 }],
    ["exec", 30 * ONE_MINUTE_MS, {}],
    ["exec", ONE_MINUTE_MS, { createdAtMs: 0, expiresAtMs: 21 * ONE_MINUTE_MS }],
  ] as const)(
    "expires %s state after %i ms and restarts its sweeper",
    async (kind, ttl, payload) => {
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 4);
      expect(vi.getTimerCount()).toBe(0);
      if (kind === "permission") {
        await subject.handleClaudePermissionRequest(permissionRequest);
      } else {
        await requestApproval(subject, { id: "approval", ...payload }, kind);
      }
      const pending =
        kind === "permission" ? subject.pendingClaudePermissions : subject.pendingApprovals;
      expect(pending.size).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(ttl - ONE_MINUTE_MS);
      expect(pending.size).toBe(1);
      vi.advanceTimersByTime(
        ttl === ONE_MINUTE_MS ? 2 * ONE_MINUTE_MS : SWEEP_INTERVAL_MS + ONE_MINUTE_MS,
      );
      if (ttl === ONE_MINUTE_MS) {
        expect(subject.listPendingApprovals()).toHaveLength(0);
      }
      expectDrained(subject);
      await subject.handleClaudePermissionRequest({ ...permissionRequest, requestId: "fghij" });
      expect(vi.getTimerCount()).toBe(1);
    },
  );
  test("close drains pending state and prevents new requests from restarting it", async () => {
    await subject.handleClaudePermissionRequest(permissionRequest);
    await requestApproval(subject, { id: "approval-1", createdAtMs: 0, expiresAtMs: ONE_HOUR_MS });
    expect(subject.pendingClaudePermissions.size).toBe(1);
    expect(subject.pendingApprovals.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await subject.close();

    expectDrained(subject);
    await subject.handleClaudePermissionRequest({ ...permissionRequest, requestId: "fghij" });
    await requestApproval(subject, { id: "approval-after-close" });
    expectDrained(subject);
  });

  test("a rejected gateway event includes error detail with verbose on", async () => {
    subject = makeBridge(true);
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(subject, "handleGatewayEvent").mockRejectedValue(new Error("handler boom"));
    await subject.dispatchGatewayEvent({ event: "exec.approval.requested", payload: {} });

    expect(writeSpy.mock.calls.map(([chunk]) => String(chunk))).toEqual([
      "openclaw mcp: gateway event exec.approval.requested failed\n",
      "openclaw mcp: gateway event exec.approval.requested error: Error: handler boom\n",
    ]);
  });
});

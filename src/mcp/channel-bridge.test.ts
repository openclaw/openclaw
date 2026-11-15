import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import type { QueueEvent, SessionMessagePayload } from "./channel-shared.js";

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

const ONE_MINUTE_MS = 60 * 1_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const SWEEP_INTERVAL_MS = 5 * ONE_MINUTE_MS;
const APPROVAL_DEFAULT_TTL_MS = 30 * ONE_MINUTE_MS;

type BridgeInternals = Pick<
  OpenClawChannelBridge,
  "handleClaudePermissionRequest" | "listPendingApprovals" | "close" | "start"
> & {
  queue: QueueEvent[];
  pendingClaudePermissions: Map<string, unknown>;
  pendingApprovals: Map<string, unknown>;
  pendingSweepInterval: NodeJS.Timeout | null;
  handleGatewayEvent: (event: GatewayEvent) => Promise<void>;
  dispatchGatewayEvent: (event: GatewayEvent) => Promise<void>;
  handleSessionMessageEvent: (payload: SessionMessagePayload) => Promise<void>;
  server: { server: { notification: (n: unknown) => Promise<void> } } | null;
};
type GatewayEvent = { event: string; payload?: Record<string, unknown> };

const bridges: BridgeInternals[] = [];
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
  bridges.push(bridge);
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
  expect(bridge.pendingSweepInterval).toBeNull();
}

function requestApproval(bridge: BridgeInternals, payload: Record<string, unknown>, kind = "exec") {
  return bridge.handleGatewayEvent({ event: `${kind}.approval.requested`, payload });
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

test("rejects startup when a retryable Gateway connect error never recovers", async () => {
  vi.useFakeTimers();
  try {
    const bridge = makeBridge();
    const started = bridge.start();
    const handled = started.catch(() => "failed" as const);
    await vi.waitFor(() => expect(startup.options).not.toBeNull());
    const onConnectError = startup.options?.onConnectError;
    if (typeof onConnectError !== "function") {
      throw new Error("Expected Gateway connect-error callback");
    }
    // Retryable failures are absorbed for reconnect resilience; readiness must
    // still settle once the deadline passes instead of pending forever.
    const retryable = new Error("gateway request timeout for connect");
    retryable.name = "GatewayClientRequestError";
    Object.assign(retryable, { retryable: true });
    onConnectError(retryable);
    await vi.advanceTimersByTimeAsync(60 * 1_000 + 10);
    await expect(handled).resolves.toBe("failed");
    await expect(started).rejects.toThrow("gateway did not become ready within 60000ms");
  } finally {
    vi.useRealTimers();
  }
});

test("extends the readiness deadline with a configured handshake budget", async () => {
  vi.useFakeTimers();
  // Drive the production timeout owner itself: an operator's
  // OPENCLAW_HANDSHAKE_TIMEOUT_MS=120000 must not be cut short by a fixed
  // one-minute deadline. (The test-run variable takes precedence in vitest,
  // so stub both.)
  vi.stubEnv("OPENCLAW_HANDSHAKE_TIMEOUT_MS", "120000");
  vi.stubEnv("OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS", "120000");
  try {
    const bridge = makeBridge();
    const started = bridge.start();
    const handled = started.catch(() => "failed" as const);
    await vi.waitFor(() => expect(startup.options).not.toBeNull());
    const onConnectError = startup.options?.onConnectError;
    if (typeof onConnectError !== "function") {
      throw new Error("Expected Gateway connect-error callback");
    }
    const retryable = new Error("gateway request timeout for connect");
    retryable.name = "GatewayClientRequestError";
    Object.assign(retryable, { retryable: true });
    onConnectError(retryable);
    // 90s: past the old fixed deadline, still inside the extended budget.
    await vi.advanceTimersByTimeAsync(90 * 1_000);
    await expect(Promise.race([started, "pending"])).resolves.not.toBe("failed");
    // 150s: handshake budget (120s) + grace (30s) has elapsed.
    await vi.advanceTimersByTimeAsync(60 * 1_000 + 10);
    await expect(handled).resolves.toBe("failed");
    await expect(started).rejects.toThrow("gateway did not become ready within 150000ms");
  } finally {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});

test("honors an extended connect-challenge watchdog in the readiness deadline", async () => {
  vi.useFakeTimers();
  // Only the challenge watchdog is raised: the client deliberately allows
  // 120s for the post-upgrade challenge, so the deadline must not fire at 60s.
  vi.stubEnv("OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS", "120000");
  try {
    const bridge = makeBridge();
    const started = bridge.start();
    const handled = started.catch(() => "failed" as const);
    await vi.waitFor(() => expect(startup.options).not.toBeNull());
    const onConnectError = startup.options?.onConnectError;
    if (typeof onConnectError !== "function") {
      throw new Error("Expected Gateway connect-error callback");
    }
    const retryable = new Error("gateway request timeout for connect");
    retryable.name = "GatewayClientRequestError";
    Object.assign(retryable, { retryable: true });
    onConnectError(retryable);
    // 90s: past the preauth-only deadline, inside the challenge budget.
    await vi.advanceTimersByTimeAsync(90 * 1_000);
    await expect(Promise.race([started, "pending"])).resolves.not.toBe("failed");
    // 150s: challenge budget (120s) + grace (30s).
    await vi.advanceTimersByTimeAsync(60 * 1_000 + 10);
    await expect(handled).resolves.toBe("failed");
    await expect(started).rejects.toThrow("gateway did not become ready within 150000ms");
  } finally {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
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
    ["permission", ONE_HOUR_MS],
    ["plugin", APPROVAL_DEFAULT_TTL_MS],
    ["exec", APPROVAL_DEFAULT_TTL_MS],
    ["early", ONE_MINUTE_MS],
  ] as const)("expires %s state and restarts the idle sweeper", async (kind, ttl) => {
    expect(subject.pendingSweepInterval).toBeNull();
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 4);
    expect(vi.getTimerCount()).toBe(0);
    if (kind === "permission") {
      await subject.handleClaudePermissionRequest(permissionRequest);
    } else {
      const payload =
        kind === "early"
          ? { id: "approval", createdAtMs: 0, expiresAtMs: Date.now() + ttl }
          : kind === "plugin"
            ? { id: "approval", createdAtMs: 0 }
            : { id: "approval" };
      await requestApproval(subject, payload, kind === "early" ? "exec" : kind);
    }
    const pending =
      kind === "permission" ? subject.pendingClaudePermissions : subject.pendingApprovals;
    expect(pending.size).toBe(1);
    expect(subject.pendingSweepInterval).not.toBeNull();
    vi.advanceTimersByTime(ttl - ONE_MINUTE_MS);
    expect(pending.size).toBe(1);
    vi.advanceTimersByTime(
      kind === "early" ? 2 * ONE_MINUTE_MS : SWEEP_INTERVAL_MS + ONE_MINUTE_MS,
    );
    if (kind === "early") {
      expect(subject.listPendingApprovals()).toHaveLength(0);
    }
    expectDrained(subject);
    expect(vi.getTimerCount()).toBe(0);
    await subject.handleClaudePermissionRequest({ ...permissionRequest, requestId: "fghij" });
    expect(subject.pendingSweepInterval).not.toBeNull();
  });
  test("close drains pending state and prevents new requests from restarting it", async () => {
    await subject.handleClaudePermissionRequest(permissionRequest);
    await requestApproval(subject, { id: "approval-1", createdAtMs: 0, expiresAtMs: ONE_HOUR_MS });
    expect(subject.pendingClaudePermissions.size).toBe(1);
    expect(subject.pendingApprovals.size).toBe(1);
    expect(subject.pendingSweepInterval).not.toBeNull();

    await subject.close();

    expectDrained(subject);
    expect(vi.getTimerCount()).toBe(0);
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

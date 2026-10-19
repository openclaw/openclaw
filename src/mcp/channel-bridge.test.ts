import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import type { QueueEvent } from "./channel-shared.js";

const ONE_MINUTE_MS = 60 * 1_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const SWEEP_INTERVAL_MS = 5 * ONE_MINUTE_MS;
const APPROVAL_DEFAULT_TTL_MS = 30 * ONE_MINUTE_MS;

type BridgeInternals = Pick<
  OpenClawChannelBridge,
  "handleClaudePermissionRequest" | "listPendingApprovals" | "close"
> & {
  queue: QueueEvent[];
  pendingClaudePermissions: Map<string, unknown>;
  pendingApprovals: Map<string, unknown>;
  pendingSweepInterval: NodeJS.Timeout | null;
  handleGatewayEvent: (event: GatewayEvent) => Promise<void>;
  dispatchGatewayEvent: (event: GatewayEvent) => Promise<void>;
  handleSessionMessageEvent: (payload: {
    sessionKey: string;
    senderIsOwner?: boolean;
    message: { role: string; content: unknown };
  }) => Promise<void>;
  server: { server: { notification: (n: unknown) => Promise<void> } } | null;
};
type GatewayEvent = { event: string; payload?: Record<string, unknown> };

const bridges: BridgeInternals[] = [];
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

describe("OpenClawChannelBridge — Claude permission authorization", () => {
  test.each([
    { name: "non-owner", senderIsOwner: false, role: "user" },
    { name: "missing owner metadata", senderIsOwner: undefined, role: "user" },
    { name: "assistant message", senderIsOwner: true, role: "assistant" },
  ])("does not resolve a pending permission from a $name reply", async (reply) => {
    const bridge = makeBridge();
    const notification = vi.fn(async () => undefined);
    bridge.server = { server: { notification } };
    await bridge.handleClaudePermissionRequest(permissionRequest);

    await bridge.handleSessionMessageEvent({
      ...permissionReply(true, reply.role),
      senderIsOwner: reply.senderIsOwner,
    });

    expect(notification).not.toHaveBeenCalled();
    expect(bridge.pendingClaudePermissions.has("abcde")).toBe(true);
    expect(bridge.queue.at(-1)).toMatchObject({ type: "message", text: "yes abcde" });
  });

  test("keeps a permission retryable until its notification is delivered", async () => {
    const bridge = makeBridge();
    const notification = vi
      .fn<(notification: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce(undefined);
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    bridge.server = { server: { notification } };
    const reply = permissionReply();
    await bridge.handleClaudePermissionRequest(permissionRequest);

    await bridge.handleSessionMessageEvent(reply);
    await bridge.handleSessionMessageEvent(reply);
    expect(notification).toHaveBeenCalledTimes(2);
    expect(writeSpy.mock.calls).toEqual([
      ["openclaw mcp: notification notifications/claude/channel/permission failed\n"],
    ]);

    await bridge.handleSessionMessageEvent(reply);
    expect(notification).toHaveBeenCalledTimes(2);
  });
});

describe("OpenClawChannelBridge — pendingClaudePermissions / pendingApprovals memory bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  test.each([
    { kind: "plugin", payload: { id: "approval-2", createdAtMs: 0 } },
    { kind: "exec", payload: { id: "approval-3" } },
  ])("expires $kind approvals with absent expiry metadata", async ({ kind, payload }) => {
    const bridge = makeBridge();
    await requestApproval(bridge, payload, kind);
    expect(bridge.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(APPROVAL_DEFAULT_TTL_MS - ONE_MINUTE_MS);
    expect(bridge.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + ONE_MINUTE_MS);
    expect(bridge.pendingApprovals.size).toBe(0);
  });

  test("listPendingApprovals filters expired entries before the next sweep tick", async () => {
    const bridge = makeBridge();
    await requestApproval(bridge, {
      id: "approval-early-expiry",
      createdAtMs: 0,
      expiresAtMs: ONE_MINUTE_MS,
    });
    expect(bridge.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(2 * ONE_MINUTE_MS);

    expect(bridge.listPendingApprovals()).toHaveLength(0);
    expect(bridge.pendingApprovals.size).toBe(0);
    expect(bridge.pendingSweepInterval).toBeNull();
  });

  test("close() clears both pending maps, stops the sweeper interval, and leaves no scheduled timers", async () => {
    const bridge = makeBridge();
    await bridge.handleClaudePermissionRequest(permissionRequest);
    await requestApproval(bridge, { id: "approval-1", createdAtMs: 0, expiresAtMs: ONE_HOUR_MS });
    expect(bridge.pendingClaudePermissions.size).toBe(1);
    expect(bridge.pendingApprovals.size).toBe(1);
    expect(bridge.pendingSweepInterval).not.toBeNull();

    await bridge.close();

    expectDrained(bridge);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("handleClaudePermissionRequest is a no-op after close(), preventing post-close accumulation", async () => {
    const bridge = makeBridge();
    await bridge.close();

    await bridge.handleClaudePermissionRequest({ ...permissionRequest, requestId: "fghij" });
    await requestApproval(bridge, { id: "approval-after-close" });

    expectDrained(bridge);
  });

  test("a rejected gateway event includes error detail with verbose on", async () => {
    const bridge = makeBridge(true);
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(bridge, "handleGatewayEvent").mockRejectedValue(new Error("handler boom"));
    await bridge.dispatchGatewayEvent({ event: "exec.approval.requested", payload: {} });

    const writes = writeSpy.mock.calls.map(([chunk]) => String(chunk));
    expect(writes).toEqual([
      "openclaw mcp: gateway event exec.approval.requested failed\n",
      "openclaw mcp: gateway event exec.approval.requested error: Error: handler boom\n",
    ]);
  });

  test("sweeper self-terminates once both maps drain, restoring lazy-init", async () => {
    const bridge = makeBridge();
    expect(bridge.pendingSweepInterval).toBeNull();
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 4);
    expect(vi.getTimerCount()).toBe(0);
    await bridge.handleClaudePermissionRequest(permissionRequest);
    expect(bridge.pendingSweepInterval).not.toBeNull();
    expect(bridge.pendingClaudePermissions.size).toBe(1);

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(bridge.pendingClaudePermissions.size).toBe(1);
    vi.advanceTimersByTime(ONE_HOUR_MS);
    expectDrained(bridge);
    expect(vi.getTimerCount()).toBe(0);

    await bridge.handleClaudePermissionRequest({ ...permissionRequest, requestId: "fghij" });
    expect(bridge.pendingSweepInterval).not.toBeNull();
  });
});

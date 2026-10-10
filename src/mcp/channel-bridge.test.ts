// Channel MCP bridge tests cover request bridging between MCP and channel APIs.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import type { QueueEvent } from "./channel-shared.js";

const ONE_MINUTE_MS = 60 * 1_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const SWEEP_INTERVAL_MS = 5 * ONE_MINUTE_MS;
const APPROVAL_DEFAULT_TTL_MS = 30 * ONE_MINUTE_MS;

type BridgeInternals = Pick<
  OpenClawChannelBridge,
  "pollEvents" | "waitForEvent" | "handleClaudePermissionRequest" | "listPendingApprovals" | "close"
> & {
  queue: QueueEvent[];
  pendingClaudePermissions: Map<string, unknown>;
  pendingApprovals: Map<string, unknown>;
  pendingSweepInterval: NodeJS.Timeout | null;
  handleGatewayEvent: (event: {
    event: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  dispatchGatewayEvent: (event: {
    event: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  handleSessionMessageEvent: (payload: {
    sessionKey: string;
    senderIsOwner?: boolean;
    message: { role: string; content: unknown };
  }) => Promise<void>;
  server: { server: { notification: (n: unknown) => Promise<void> } } | null;
  sendNotification: (notification: { method: string }) => Promise<void>;
};

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
    {
      claudeChannelMode: "off",
      verbose,
    },
  ) as unknown as BridgeInternals;
  bridges.push(bridge);
  return bridge;
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
      sessionKey: "agent:main:telegram:group:-100123",
      senderIsOwner: reply.senderIsOwner,
      message: {
        role: reply.role,
        content: [{ type: "text", text: "yes abcde" }],
      },
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
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    bridge.server = { server: { notification } };
    const reply = {
      sessionKey: "agent:main:telegram:group:-100123",
      senderIsOwner: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "yes abcde" }],
      },
    };
    await bridge.handleClaudePermissionRequest(permissionRequest);

    await bridge.handleSessionMessageEvent(reply);
    await bridge.handleSessionMessageEvent(reply);
    expect(notification).toHaveBeenCalledTimes(2);

    await bridge.handleSessionMessageEvent(reply);
    expect(notification).toHaveBeenCalledTimes(2);
  });
});

describe("OpenClawChannelBridge — pendingClaudePermissions / pendingApprovals memory bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  test("trackApproval entries are evicted at expiresAtMs by the sweeper", async () => {
    const bridge = makeBridge();
    await bridge.handleGatewayEvent({
      event: "exec.approval.requested",
      payload: {
        id: "approval-1",
        createdAtMs: 0,
        expiresAtMs: 10 * ONE_MINUTE_MS,
      },
    });
    expect(bridge.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(bridge.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + ONE_MINUTE_MS);
    expect(bridge.pendingApprovals.size).toBe(0);
  });

  test("trackApproval falls back to a default TTL when expiresAtMs is absent", async () => {
    const bridge = makeBridge();
    await bridge.handleGatewayEvent({
      event: "plugin.approval.requested",
      payload: { id: "approval-2", createdAtMs: 0 },
    });
    expect(bridge.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(APPROVAL_DEFAULT_TTL_MS - ONE_MINUTE_MS);
    expect(bridge.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + ONE_MINUTE_MS);
    expect(bridge.pendingApprovals.size).toBe(0);
  });

  test("trackApproval evicts entries even when both createdAtMs and expiresAtMs are absent", async () => {
    const bridge = makeBridge();
    await bridge.handleGatewayEvent({
      event: "exec.approval.requested",
      payload: { id: "approval-3" },
    });
    expect(bridge.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(APPROVAL_DEFAULT_TTL_MS - ONE_MINUTE_MS);
    expect(bridge.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + ONE_MINUTE_MS);
    expect(bridge.pendingApprovals.size).toBe(0);
  });

  test("listPendingApprovals filters expired entries before the next sweep tick", async () => {
    const bridge = makeBridge();
    await bridge.handleGatewayEvent({
      event: "exec.approval.requested",
      payload: {
        id: "approval-early-expiry",
        createdAtMs: 0,
        expiresAtMs: ONE_MINUTE_MS,
      },
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
    await bridge.handleGatewayEvent({
      event: "exec.approval.requested",
      payload: { id: "approval-1", createdAtMs: 0, expiresAtMs: ONE_HOUR_MS },
    });
    expect(bridge.pendingClaudePermissions.size).toBe(1);
    expect(bridge.pendingApprovals.size).toBe(1);
    expect(bridge.pendingSweepInterval).not.toBeNull();

    await bridge.close();

    expect(bridge.pendingClaudePermissions.size).toBe(0);
    expect(bridge.pendingApprovals.size).toBe(0);
    expect(bridge.pendingSweepInterval).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("handleClaudePermissionRequest is a no-op after close(), preventing post-close accumulation", async () => {
    const bridge = makeBridge();
    await bridge.close();

    await bridge.handleClaudePermissionRequest({
      requestId: "fghij",
      toolName: "Bash",
      description: "after close",
      inputPreview: "{}",
    });
    await bridge.handleGatewayEvent({
      event: "exec.approval.requested",
      payload: { id: "approval-after-close" },
    });

    expect(bridge.pendingClaudePermissions.size).toBe(0);
    expect(bridge.pendingApprovals.size).toBe(0);
    expect(bridge.pendingSweepInterval).toBeNull();
  });

  test("a failed notification still emits exactly one diagnostic record with verbose off", async () => {
    const bridge = makeBridge(false);
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    bridge.server = {
      server: {
        notification: () => Promise.reject(new Error("transport closed")),
      },
    };
    await bridge.sendNotification({ method: "channel/event" });

    const writes = writeSpy.mock.calls.map(([chunk]) => String(chunk));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("openclaw mcp: notification channel/event failed\n");
    expect(writes[0]).not.toContain("transport closed");
  });

  test("a rejected gateway event still emits exactly one diagnostic record with verbose off", async () => {
    const bridge = makeBridge(false);
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(bridge, "handleGatewayEvent").mockRejectedValue(new Error("handler boom"));
    await bridge.dispatchGatewayEvent({ event: "exec.approval.requested", payload: {} });

    const writes = writeSpy.mock.calls.map(([chunk]) => String(chunk));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("openclaw mcp: gateway event exec.approval.requested failed\n");
    expect(writes[0]).not.toContain("handler boom");
  });

  test("a rejected gateway event includes error detail with verbose on", async () => {
    const bridge = makeBridge(true);
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(bridge, "handleGatewayEvent").mockRejectedValue(new Error("handler boom"));
    await bridge.dispatchGatewayEvent({ event: "exec.approval.requested", payload: {} });

    const writes = writeSpy.mock.calls.map(([chunk]) => String(chunk));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe("openclaw mcp: gateway event exec.approval.requested failed\n");
    expect(writes[1]).toBe(
      "openclaw mcp: gateway event exec.approval.requested error: Error: handler boom\n",
    );
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
    expect(bridge.pendingClaudePermissions.size).toBe(0);
    expect(bridge.pendingApprovals.size).toBe(0);
    expect(bridge.pendingSweepInterval).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await bridge.handleClaudePermissionRequest({
      requestId: "fghij",
      toolName: "Bash",
      description: "second request after drain",
      inputPreview: "{}",
    });
    expect(bridge.pendingSweepInterval).not.toBeNull();
  });

  test("pollEvents clamps direct caller limits to the public MCP event window", async () => {
    const bridge = makeBridge();
    for (let cursor = 1; cursor <= 250; cursor += 1) {
      bridge.queue.push({
        cursor,
        type: "message",
        sessionKey: "agent:main:main",
        raw: { sessionKey: "agent:main:main" },
      });
    }

    const result = bridge.pollEvents({ afterCursor: 0 }, 10_000);

    expect(result.events).toHaveLength(200);
    expect(result.nextCursor).toBe(200);
  });

  test("waitForEvent clamps oversized direct caller timeouts before arming timers", async () => {
    const bridge = makeBridge();
    let resolved = false;
    const waited = bridge.waitForEvent({ afterCursor: 0 }, 3_000_000_000).then((event) => {
      resolved = true;
      return event;
    });
    await Promise.resolve();

    vi.advanceTimersByTime(299_999);
    await Promise.resolve();
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(1);
    await expect(waited).resolves.toEqual({ event: null });
    expect(resolved).toBe(true);
  });
});

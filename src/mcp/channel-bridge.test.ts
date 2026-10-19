import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import type { QueueEvent, SessionMessagePayload } from "./channel-shared.js";

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  subject = makeBridge();
});

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OpenClawChannelBridge", () => {
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
    { kind: "plugin", payload: { id: "approval-2", createdAtMs: 0 } },
    { kind: "exec", payload: { id: "approval-3" } },
  ])("expires $kind approvals with absent expiry metadata", async ({ kind, payload }) => {
    await requestApproval(subject, payload, kind);
    expect(subject.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(APPROVAL_DEFAULT_TTL_MS - ONE_MINUTE_MS);
    expect(subject.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + ONE_MINUTE_MS);
    expect(subject.pendingApprovals.size).toBe(0);
  });

  test("listPendingApprovals filters expired entries before the next sweep tick", async () => {
    await requestApproval(subject, {
      id: "approval-early-expiry",
      createdAtMs: 0,
      expiresAtMs: ONE_MINUTE_MS,
    });
    expect(subject.pendingApprovals.size).toBe(1);

    vi.advanceTimersByTime(2 * ONE_MINUTE_MS);

    expect(subject.listPendingApprovals()).toHaveLength(0);
    expect(subject.pendingApprovals.size).toBe(0);
    expect(subject.pendingSweepInterval).toBeNull();
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

  test("sweeper self-terminates once both maps drain, restoring lazy-init", async () => {
    expect(subject.pendingSweepInterval).toBeNull();
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 4);
    expect(vi.getTimerCount()).toBe(0);
    await subject.handleClaudePermissionRequest(permissionRequest);
    expect(subject.pendingSweepInterval).not.toBeNull();
    expect(subject.pendingClaudePermissions.size).toBe(1);

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(subject.pendingClaudePermissions.size).toBe(1);
    vi.advanceTimersByTime(ONE_HOUR_MS);
    expectDrained(subject);
    expect(vi.getTimerCount()).toBe(0);

    await subject.handleClaudePermissionRequest({ ...permissionRequest, requestId: "fghij" });
    expect(subject.pendingSweepInterval).not.toBeNull();
  });
});

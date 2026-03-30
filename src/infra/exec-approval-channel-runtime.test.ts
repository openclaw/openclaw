import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGatewayClientStarts = vi.hoisted(() => vi.fn());
const mockGatewayClientStops = vi.hoisted(() => vi.fn());
const mockGatewayClientRequests = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const mockCreateOperatorApprovalsGatewayClient = vi.hoisted(() => vi.fn());

vi.mock("../gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: mockCreateOperatorApprovalsGatewayClient,
}));

let createExecApprovalChannelRuntime: typeof import("./exec-approval-channel-runtime.js").createExecApprovalChannelRuntime;

beforeEach(() => {
  mockGatewayClientStarts.mockReset();
  mockGatewayClientStops.mockReset();
  mockGatewayClientRequests.mockReset();
  mockGatewayClientRequests.mockResolvedValue({ ok: true });
  mockCreateOperatorApprovalsGatewayClient.mockReset().mockImplementation(async () => ({
    start: mockGatewayClientStarts,
    stop: mockGatewayClientStops,
    request: mockGatewayClientRequests,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.resetModules();
  ({ createExecApprovalChannelRuntime } = await import("./exec-approval-channel-runtime.js"));
});

describe("createExecApprovalChannelRuntime", () => {
  it("does not connect when the adapter is not configured", async () => {
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: {} as never,
      isConfigured: () => false,
      shouldHandle: () => true,
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
    });

    await runtime.start();

    expect(mockCreateOperatorApprovalsGatewayClient).not.toHaveBeenCalled();
  });

  it("tracks pending requests and only expires the matching approval id", async () => {
    vi.useFakeTimers();
    const finalizedExpired = vi.fn(async () => undefined);
    const finalizedResolved = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: {} as never,
      nowMs: () => 1000,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async (request) => [{ id: request.id }],
      finalizeResolved: finalizedResolved,
      finalizeExpired: finalizedExpired,
    });

    await runtime.handleRequested({
      id: "abc",
      request: {
        command: "echo abc",
      },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });
    await runtime.handleRequested({
      id: "xyz",
      request: {
        command: "echo xyz",
      },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });

    await runtime.handleExpired("abc");

    expect(finalizedExpired).toHaveBeenCalledTimes(1);
    expect(finalizedExpired).toHaveBeenCalledWith({
      request: expect.objectContaining({ id: "abc" }),
      entries: [{ id: "abc" }],
    });
    expect(finalizedResolved).not.toHaveBeenCalled();

    await runtime.handleResolved({
      id: "xyz",
      decision: "allow-once",
      ts: 1500,
    });

    expect(finalizedResolved).toHaveBeenCalledTimes(1);
    expect(finalizedResolved).toHaveBeenCalledWith({
      request: expect.objectContaining({ id: "xyz" }),
      resolved: expect.objectContaining({ id: "xyz", decision: "allow-once" }),
      entries: [{ id: "xyz" }],
    });
  });

  it("routes gateway requests through the shared client", async () => {
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
    });

    await runtime.start();
    await runtime.request("exec.approval.resolve", { id: "abc", decision: "deny" });

    expect(mockGatewayClientStarts).toHaveBeenCalledTimes(1);
    expect(mockGatewayClientRequests).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "abc",
      decision: "deny",
    });
  });

  it("subscribes to plugin approval events when requested", async () => {
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const finalizeResolved = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime({
      label: "test/plugin-approvals",
      clientDisplayName: "Test Plugin Approvals",
      cfg: {} as never,
      eventKinds: ["plugin"],
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested,
      finalizeResolved,
    });

    await runtime.start();
    const clientParams = mockCreateOperatorApprovalsGatewayClient.mock.calls[0]?.[0] as
      | { onEvent?: (evt: { event: string; payload: unknown }) => void }
      | undefined;
    expect(clientParams?.onEvent).toBeTypeOf("function");

    clientParams?.onEvent?.({
      event: "plugin.approval.requested",
      payload: {
        id: "plugin:abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
        },
        createdAtMs: 1000,
        expiresAtMs: 2000,
      },
    });
    await vi.waitFor(() => {
      expect(deliverRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "plugin:abc",
        }),
      );
    });

    clientParams?.onEvent?.({
      event: "plugin.approval.resolved",
      payload: {
        id: "plugin:abc",
        decision: "allow-once",
        ts: 1500,
      },
    });
    await vi.waitFor(() => {
      expect(finalizeResolved).toHaveBeenCalledWith({
        request: expect.objectContaining({ id: "plugin:abc" }),
        resolved: expect.objectContaining({ id: "plugin:abc", decision: "allow-once" }),
        entries: [{ id: "plugin:abc" }],
      });
    });
  });
});

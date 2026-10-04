import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { requestMcpAppToolApproval } from "./mcp-app-tool-approval.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
const mocks = vi.hoisted(() => ({ deliver: vi.fn(), bind: vi.fn() }));
vi.mock("./server-methods/approval-request-delivery.js", () => ({
  handlePendingApprovalRequestWithDelivery: mocks.deliver,
}));
vi.mock("./server-methods/approval-shared.js", () => ({
  bindApprovalRequesterMetadata: mocks.bind,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.deliver.mockResolvedValue(undefined);
});
function fixture(decision = Promise.resolve("allow-once")) {
  const manager = {
    create: vi.fn((request, _timeout, id) => ({ id, request })),
    register: vi.fn(async () => ({ decision })),
    consumeAllowOnce: vi.fn(async () => true),
    projectDecisionIfActive: vi.fn((_id, value) => value),
  };
  const assertCurrent = vi.fn();
  const options = {
    context: { pluginApprovalManager: manager },
    client: { connId: "viewer" },
    signal: new AbortController().signal,
  } as unknown as GatewayRequestHandlerOptions;
  const params = {
    options,
    agentId: "main",
    sessionKey: "agent:main:app",
    serverName: "demo",
    toolName: "save",
    input: { value: 1 },
    assertCurrent,
  };
  return { manager, params, assertCurrent };
}
describe("MCP App one-shot approvals", () => {
  it("uses the shared reviewer and delivery owner, then consumes the exact call once", async () => {
    const f = fixture();
    await requestMcpAppToolApproval(f.params);
    const record = f.manager.create.mock.results[0]!.value;
    expect(record.request).toMatchObject({
      pluginId: "bundle-mcp",
      sessionKey: "agent:main:app",
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(record.request).not.toHaveProperty("mcpTool");
    expect(mocks.bind).toHaveBeenCalledWith({ record, client: f.params.options.client });
    expect(mocks.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ manager: f.manager, record, twoPhase: false }),
    );
    expect(f.manager.consumeAllowOnce).toHaveBeenCalledExactlyOnceWith(
      record.id,
      "mcp.app:" + record.request.toolCallId,
    );
  });
  it("waits for the review decision instead of treating request registration as approval", async () => {
    const decision = createDeferred<string>();
    const delivered = createDeferred();
    mocks.deliver.mockImplementation(async () => {
      delivered.resolve();
    });
    const f = fixture(decision.promise);
    const pending = requestMcpAppToolApproval(f.params);
    await delivered.promise;
    expect(f.manager.consumeAllowOnce).not.toHaveBeenCalled();
    decision.resolve("allow-once");
    await pending;
    expect(f.manager.consumeAllowOnce).toHaveBeenCalledOnce();
  });
  it("uses the shared bounded preview for large App payloads without skipping approval", async () => {
    const f = fixture();
    const input = { preview: "x".repeat(20_000) };
    await requestMcpAppToolApproval({ ...f.params, input });
    const record = f.manager.create.mock.results[0]!.value;
    expect(record.request.detail.length).toBeLessThanOrEqual(16_384);
    expect(record.request.detail).toContain("[truncated]");
    expect(record.request.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(f.manager.consumeAllowOnce).toHaveBeenCalledExactlyOnceWith(
      record.id,
      "mcp.app:" + record.request.toolCallId,
    );
    expect(input.preview).toHaveLength(20_000);
  });
  it("does not consume denied approvals", async () => {
    const f = fixture(Promise.resolve("deny"));
    await expect(requestMcpAppToolApproval(f.params)).rejects.toThrow("denied");
    expect(f.manager.consumeAllowOnce).not.toHaveBeenCalled();
  });
  it("rejects requester revocation during review", async () => {
    const f = fixture();
    mocks.deliver.mockImplementation(async () => {
      f.assertCurrent.mockImplementation(() => {
        throw new Error("revoked");
      });
    });
    await expect(requestMcpAppToolApproval(f.params)).rejects.toThrow("revoked");
    expect(f.manager.consumeAllowOnce).not.toHaveBeenCalled();
  });
  it("rejects a consumed or stale approval without granting tool execution", async () => {
    const f = fixture();
    f.manager.consumeAllowOnce.mockResolvedValue(false);
    await expect(requestMcpAppToolApproval(f.params)).rejects.toThrow("no longer available");
  });
});

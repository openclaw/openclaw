import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { toolsInvokeHandlers } from "./tools-invoke.js";

const coreMocks = vi.hoisted(() => ({
  invokeGatewayTool: vi.fn(),
}));

vi.mock("../tools-invoke-core.js", () => coreMocks);

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

async function invoke(params: Record<string, unknown>, scopes: string[] = ["operator.write"]) {
  const respond = vi.fn();
  await toolsInvokeHandlers["tools.invoke"]({
    params,
    respond: respond as never,
    context: { getRuntimeConfig: () => ({}) } as never,
    client: {
      connect: { scopes },
    } as never,
    req: { type: "req", id: "req-1", method: "tools.invoke" },
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("tools.invoke handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid params", async () => {
    const respond = await invoke({ args: {} });
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.invoke params");
    expect(coreMocks.invokeGatewayTool).not.toHaveBeenCalled();
  });

  it("invokes tools with admin callers treated as owner", async () => {
    coreMocks.invokeGatewayTool.mockResolvedValueOnce({
      status: 200,
      body: { ok: true, toolName: "demo", output: { text: "done" } },
    });

    const respond = await invoke(
      {
        name: "demo",
        args: { input: "hello" },
        sessionKey: "agent:main:main",
        agentId: "main",
        confirm: true,
        idempotencyKey: "invoke-1",
      },
      ["operator.admin"],
    );

    expect(coreMocks.invokeGatewayTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "demo",
        args: { input: "hello" },
        sessionKey: "agent:main:main",
        agentId: "main",
        confirm: true,
        idempotencyKey: "invoke-1",
        senderIsOwner: true,
        surface: "http",
      }),
    );
    expect(respond.mock.calls[0]).toEqual([
      true,
      { ok: true, toolName: "demo", output: { text: "done" } },
      undefined,
    ]);
  });

  it("returns typed approval-required results without failing the RPC frame", async () => {
    coreMocks.invokeGatewayTool.mockResolvedValueOnce({
      status: 200,
      body: {
        ok: false,
        toolName: "demo",
        requiresApproval: true,
        approvalId: "plugin:approval-1",
        error: { type: "approval_required", message: "Needs approval" },
      },
    });

    const respond = await invoke({ name: "demo", args: { input: "hello" } });

    expect(coreMocks.invokeGatewayTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "demo",
        confirm: false,
        senderIsOwner: false,
      }),
    );
    expect(respond.mock.calls[0]).toEqual([
      true,
      {
        ok: false,
        toolName: "demo",
        requiresApproval: true,
        approvalId: "plugin:approval-1",
        error: { type: "approval_required", message: "Needs approval" },
      },
      undefined,
    ]);
  });

  it("maps core invalid requests to Gateway invalid_request errors", async () => {
    coreMocks.invokeGatewayTool.mockResolvedValueOnce({
      status: 400,
      body: {
        ok: false,
        error: { type: "invalid_request", message: 'unknown agent id "other"' },
      },
    });

    const respond = await invoke({ name: "demo", agentId: "other" });
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown agent id "other"');
  });
});

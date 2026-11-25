import { beforeEach, expect, it, vi } from "vitest";
import { createTestOperatorAuthority } from "../../agents/admitted-run-context.test-support.js";
import { invokeGatewayTool } from "../tools-invoke-shared.js";
import { toolsInvokeHandlers } from "./tools-invoke.js";

// mock-isolation: the cells observe only the owner bit the handler hands to tool invocation.
vi.mock("../tools-invoke-shared.js", () => ({ invokeGatewayTool: vi.fn() }));

const invoke = vi.mocked(invokeGatewayTool);
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ ok: true, toolName: "sessions", result: {}, source: "core" } as never);
});

// A plugin or agent tool dispatches `tools.invoke` in process with least-privilege scopes and
// its run's admitted authority; the run's grant decides the owner, the same as the owner's socket.
it.each([
  { name: "owner socket", scopes: ["operator.admin"], run: undefined, owner: true },
  { name: "write socket", scopes: ["operator.write"], run: undefined, owner: false },
  { name: "owner run", scopes: ["operator.write"], run: ["operator.admin"], owner: true },
  { name: "member run", scopes: ["operator.write"], run: ["operator.write"], owner: false },
])("tools.invoke owner comes from the request grant: $name", async (cell) => {
  const operatorRunAuthority =
    cell.run && createTestOperatorAuthority({ profileId: "requester", scopes: cell.run });
  const respond = vi.fn();
  await toolsInvokeHandlers["tools.invoke"]!({
    params: { name: "sessions", args: {} },
    respond,
    context: { getRuntimeConfig: () => ({}) } as never,
    req: { type: "req", id: "1", method: "tools.invoke" },
    client: {
      connect: { scopes: cell.scopes },
      ...(operatorRunAuthority ? { internal: { operatorRunAuthority } } : {}),
    } as never,
    isWebchatConnect: () => false,
  });
  expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ senderIsOwner: cell.owner }));
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
});

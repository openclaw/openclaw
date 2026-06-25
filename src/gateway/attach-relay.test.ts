import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: vi.fn(() => ({ agentId: "agent-x", tools: [{ name: "t1" }] })),
}));
vi.mock("./mcp-http.handlers.js", () => ({
  handleMcpJsonRpc: vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
}));
vi.mock("./mcp-http.schema.js", () => ({
  buildMcpToolSchema: vi.fn((tools: Array<{ name: string }>) =>
    tools.map((t) => ({ name: t.name })),
  ),
}));

import { dispatchAttachMcpMessage } from "./attach-relay.js";
import { mintAttachGrant, resetAttachGrantsForTest } from "./mcp-grant-store.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const cfg = {} as never;
const msg = { jsonrpc: "2.0" as const, id: 1, method: "tools/list", params: {} };

describe("dispatchAttachMcpMessage (conduit relay core)", () => {
  afterEach(() => resetAttachGrantsForTest());

  it("rejects an unknown/expired grant with an auth error and dispatches nothing", async () => {
    const res = await dispatchAttachMcpMessage({ grantToken: "nope", message: msg, cfg });
    expect((res as { error?: { code: number } }).error?.code).toBe(-32001);
    expect(resolveGatewayScopedTools).not.toHaveBeenCalled();
    expect(handleMcpJsonRpc).not.toHaveBeenCalled();
  });

  it("resolves scope from the GRANT (non-owner, loopback) and dispatches via the shared handler", async () => {
    const grant = mintAttachGrant({ sessionKey: "agent:main:relay" });
    const res = await dispatchAttachMcpMessage({ grantToken: grant.token, message: msg, cfg });
    // scope is sourced from the grant's sessionKey, never the caller — a relay can't widen it
    expect(resolveGatewayScopedTools).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:relay",
        senderIsOwner: false,
        surface: "loopback",
      }),
    );
    // the MCP message goes to the SAME handler the HTTP path uses, with the scoped tools + agentId
    expect(handleMcpJsonRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        message: msg,
        tools: [{ name: "t1" }],
        hookContext: expect.objectContaining({
          agentId: "agent-x",
          sessionKey: "agent:main:relay",
        }),
      }),
    );
    expect((res as { result?: unknown }).result).toEqual({ ok: true });
  });
});

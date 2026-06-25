import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/sessions.js", async (importActual) => ({
  ...(await importActual<typeof import("../../config/sessions.js")>()),
  resolveMainSessionKey: vi.fn(() => "agent:main"),
}));
vi.mock("../attach-relay.js", () => ({
  dispatchAttachMcpMessage: vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
}));

import { dispatchAttachMcpMessage } from "../attach-relay.js";
import { resetAttachGrantsForTest, resolveAttachGrant } from "../mcp-grant-store.js";
import { nodeHandlers } from "./nodes.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const ctx = { getRuntimeConfig: () => ({}) };
const call = (method: string, params: unknown, respond: ReturnType<typeof vi.fn>) =>
  nodeHandlers[method]({
    params,
    respond,
    context: ctx,
  } as unknown as GatewayRequestHandlerOptions);

describe("node attach handlers (PR5 node conduit)", () => {
  afterEach(() => resetAttachGrantsForTest());

  it("node.attachGrant mints a session-bound grant for the node's MAIN session (pairing = authz)", async () => {
    const respond = vi.fn();
    await call("node.attachGrant", {}, respond);
    const [ok, body] = respond.mock.calls[0] as [boolean, { sessionKey: string; token: string }];
    expect(ok).toBe(true);
    expect(body.sessionKey).toBe("agent:main"); // bound to the gateway session, not node-supplied
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    // the minted token resolves to the same session in the shared grant store
    expect(resolveAttachGrant(body.token)?.sessionKey).toBe("agent:main");
  });

  it("node.attachRelay rejects a non-JSON-RPC message and otherwise dispatches via the relay core", async () => {
    const bad = vi.fn();
    await call("node.attachRelay", { grantToken: "t" }, bad); // missing mcpMessage
    expect(bad.mock.calls[0][0]).toBe(false);
    expect(dispatchAttachMcpMessage).not.toHaveBeenCalled();

    const ok = vi.fn();
    await call(
      "node.attachRelay",
      { grantToken: "tok", mcpMessage: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
      ok,
    );
    expect(dispatchAttachMcpMessage).toHaveBeenCalledWith(
      expect.objectContaining({ grantToken: "tok" }),
    );
    expect(ok).toHaveBeenCalledWith(true, {
      mcpResponse: { jsonrpc: "2.0", id: 1, result: { ok: true } },
    });
  });

  it("node.attachHydrate rejects an unknown/expired grant before touching the session store", async () => {
    const respond = vi.fn();
    await call("node.attachHydrate", { grantToken: "nope" }, respond);
    expect(respond.mock.calls[0][0]).toBe(false);
  });
});

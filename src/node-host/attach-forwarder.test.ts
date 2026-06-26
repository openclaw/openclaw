import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type NodeAttachForwarder, startNodeAttachForwarder } from "./attach-forwarder.js";

let fwd: NodeAttachForwarder | undefined;
afterEach(async () => {
  await fwd?.close();
  fwd = undefined;
});

async function postMcp(url: string, body: unknown, token?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe("node attach forwarder (PR5 conduit)", () => {
  it("relays a POSTed MCP message over node.attachRelay with the bearer grant token", async () => {
    const request = vi.fn(async () => ({
      mcpResponse: { jsonrpc: "2.0", id: 7, result: { ok: true } },
    }));
    fwd = await startNodeAttachForwarder({ client: { request } });
    const msg = { jsonrpc: "2.0", id: 7, method: "tools/list" };
    const { status, json } = await postMcp(fwd.url, msg, "tok-abc");
    expect(status).toBe(200);
    expect(json).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    // the grant token comes off the harness's Authorization header; scope is bound gateway-side
    expect(request).toHaveBeenCalledWith("node.attachRelay", {
      grantToken: "tok-abc",
      mcpMessage: msg,
    });
  });

  it("emits 202 with no body for a relayed notification (null response)", async () => {
    const request = vi.fn(async () => ({ mcpResponse: null }));
    fwd = await startNodeAttachForwarder({ client: { request } });
    const res = await fetch(fwd.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
  });

  it("returns a JSON-RPC parse error for a malformed body", async () => {
    fwd = await startNodeAttachForwarder({ client: { request: vi.fn() } });
    const res = await fetch(fwd.url, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("surfaces a relay failure as a 502 JSON-RPC error (link down)", async () => {
    const request = vi.fn(async () => {
      throw new Error("link down");
    });
    fwd = await startNodeAttachForwarder({ client: { request } });
    const { status, json } = await postMcp(fwd.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(status).toBe(502);
    expect(json).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32001 } }); // error envelope carries the request id
  });

  it("rejects a body over the 4MB cap without relaying it", async () => {
    const request = vi.fn(async () => ({ mcpResponse: { ok: 1 } }));
    fwd = await startNodeAttachForwarder({ client: { request } });
    const huge = "x".repeat(4 * 1024 * 1024 + 1024); // > MAX_BODY_BYTES
    // the server destroys the request once the body exceeds the cap → the connection resets
    await expect(
      fetch(fwd.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: huge,
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled(); // never relayed an over-cap body
  });

  it("declines the GET notification stream with 405 (no server-initiated events)", async () => {
    fwd = await startNodeAttachForwarder({ client: { request: vi.fn() } });
    const res = await fetch(fwd.url, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("survives a client that aborts mid-request and keeps serving (no host crash)", async () => {
    fwd = await startNodeAttachForwarder({
      client: { request: vi.fn(async () => ({ mcpResponse: { ok: 1 } })) },
    });
    // announce a 1000-byte body, send a fragment, then yank the socket → server req 'error'
    await new Promise<void>((resolve) => {
      const sock = net.connect(fwd!.port, "127.0.0.1", () => {
        sock.write("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\npartial");
        sock.destroy();
        resolve();
      });
    });
    // the forwarder did not crash the host — a normal request still succeeds
    const { status } = await postMcp(fwd.url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(200);
  });
});

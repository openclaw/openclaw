import { expect, it, vi } from "vitest";
import { GatewayBrowserClient, GatewayPayloadLimitError } from "./gateway.ts";

const REQUEST_FRAME_ID = "2:00000000-0000-4000-8000-000000000000";

function requestFrameBytes(method: string, params?: unknown): number {
  const frame =
    params === undefined
      ? { type: "req", id: REQUEST_FRAME_ID, method }
      : { type: "req", id: REQUEST_FRAME_ID, method, params };
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

type TestSocket = {
  sent: string[];
  emitMessage(data: unknown): void;
  emitClose(code?: number, reason?: string): void;
};
type ConnectFrame = { id?: string };
type GatewayPayloadLimitNodeTestDeps<TSocket extends TestSocket> = {
  defaultGatewayUrl: string;
  getLatestWebSocket: () => TSocket;
  startConnect: (
    client: InstanceType<typeof GatewayBrowserClient>,
    nonce?: string,
  ) => Promise<{ ws: TSocket; connectFrame: ConnectFrame }>;
  continueConnect: (
    ws: TSocket,
    nonce?: string,
  ) => Promise<{ ws: TSocket; connectFrame: ConnectFrame }>;
  useNodeFakeTimers: () => void;
};

export function registerGatewayPayloadLimitNodeTests<TSocket extends TestSocket>(
  deps: GatewayPayloadLimitNodeTestDeps<TSocket>,
): void {
  it("rejects oversized frames against the negotiated payload before sending", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });
    const { ws, connectFrame } = await deps.startConnect(client);
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 128 },
      },
    });
    await vi.waitFor(() => expect(client.connected).toBe(true));
    ws.sent.length = 0;

    const oversized = client.request("chat.send", { text: "x".repeat(256) });
    await expect(oversized).rejects.toBeInstanceOf(GatewayPayloadLimitError);
    await expect(oversized).rejects.toThrow(
      "gateway request chat.send exceeds negotiated max payload",
    );
    await expect(oversized).rejects.toThrow(
      "Shorten the message or remove one or more attachments and retry.",
    );
    expect(ws.sent).toHaveLength(0);

    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode");
    const request = client.request("sessions.list", { includeGlobal: true });
    const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string; method?: string };
    expect(frame.method).toBe("sessions.list");
    expect(encodeSpy).toHaveBeenCalledOnce();
    ws.emitMessage({
      type: "res",
      id: frame.id,
      ok: true,
      payload: { sessions: [] },
    });
    await expect(request).resolves.toEqual({ sessions: [] });
  });

  it("keeps the default payload limit for a fractional policy", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });
    const { ws, connectFrame } = await deps.startConnect(client);
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 0.5 },
      },
    });
    await vi.waitFor(() => expect(client.connected).toBe(true));
    ws.sent.length = 0;

    const request = client.request("sessions.list", { includeGlobal: true });
    const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string; method?: string };
    expect(frame.method).toBe("sessions.list");
    ws.emitMessage({
      type: "res",
      id: frame.id,
      ok: true,
      payload: { sessions: [] },
    });
    await expect(request).resolves.toEqual({ sessions: [] });
  });

  it("resets the negotiated payload limit when reconnecting to a policyless Gateway", async () => {
    deps.useNodeFakeTimers();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });
    const { ws: firstWs, connectFrame: firstConnect } = await deps.startConnect(client);
    firstWs.emitMessage({
      type: "res",
      id: firstConnect.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 128 },
      },
    });
    await vi.waitFor(() => expect(client.connected).toBe(true));

    firstWs.emitClose(1006, "socket lost");
    await vi.advanceTimersByTimeAsync(800);
    const secondWs = deps.getLatestWebSocket();
    expect(secondWs).not.toBe(firstWs);
    const { connectFrame: secondConnect } = await deps.continueConnect(
      secondWs,
      "nonce-policyless",
    );
    secondWs.emitMessage({
      type: "res",
      id: secondConnect.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
      },
    });
    await vi.waitFor(() => expect(client.connected).toBe(true));
    secondWs.sent.length = 0;

    const request = client.request("chat.send", { text: "x".repeat(256) });
    const frame = JSON.parse(secondWs.sent.at(-1) ?? "{}") as { id?: string; method?: string };
    expect(frame.method).toBe("chat.send");
    secondWs.emitMessage({
      type: "res",
      id: frame.id,
      ok: true,
      payload: { ok: true },
    });
    await expect(request).resolves.toEqual({ ok: true });
  });

  it("rejects oversized pre-auth connect frames before sending", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });
    const { ws, connectFrame } = await deps.startConnect(client);
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
      },
    });
    await vi.waitFor(() => expect(client.connected).toBe(true));
    ws.sent.length = 0;

    await expect(client.request("connect", { pathEnv: "x".repeat(70 * 1024) })).rejects.toThrow(
      "gateway request connect exceeds pre-auth max payload",
    );
    expect(ws.sent).toHaveLength(0);

    const request = client.request("sessions.list", { includeGlobal: true });
    const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string; method?: string };
    expect(frame.method).toBe("sessions.list");
    ws.emitMessage({
      type: "res",
      id: frame.id,
      ok: true,
      payload: { sessions: [] },
    });
    await expect(request).resolves.toEqual({ sessions: [] });
  });

  it.each([
    { name: "defined params exactly at the limit", method: "status.get", params: {}, delta: 0 },
    { name: "defined params one byte over", method: "status.get", params: {}, delta: -1 },
    { name: "undefined params exactly at the limit", method: "status.get", delta: 0 },
    { name: "undefined params one byte over", method: "status.get", delta: -1 },
    {
      name: "UTF-8 method and params exactly at the limit",
      method: "méthod.界",
      params: { value: "🦞" },
      delta: 0,
    },
    {
      name: "UTF-8 method and params one byte over",
      method: "méthod.界",
      params: { value: "🦞" },
      delta: -1,
    },
  ])("enforces $name", async ({ method, params, delta }) => {
    const maxPayload = requestFrameBytes(method, params) + delta;
    const onHello = vi.fn();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onHello,
    });
    const { ws, connectFrame } = await deps.startConnect(client, `nonce-${method}-${delta}`);
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload, maxBufferedBytes: maxPayload * 2, tickIntervalMs: 30_000 },
      },
    });
    await vi.waitFor(() => expect(onHello).toHaveBeenCalledOnce());

    const sentBefore = ws.sent.length;
    const request = client.request(method, params);
    if (delta < 0) {
      await expect(request).rejects.toThrow(
        `gateway request ${method} exceeds negotiated max payload`,
      );
      expect(ws.sent).toHaveLength(sentBefore);
    } else {
      const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string; method?: string };
      expect(frame.method).toBe(method);
      expect(new TextEncoder().encode(ws.sent.at(-1)).byteLength).toBe(maxPayload);
      ws.emitMessage({ type: "res", id: frame.id, ok: true, payload: { ok: true } });
      await expect(request).resolves.toEqual({ ok: true });
    }
    if (method.includes("界")) {
      expect(maxPayload).toBeGreaterThan(
        JSON.stringify(
          params === undefined
            ? { type: "req", id: REQUEST_FRAME_ID, method }
            : { type: "req", id: REQUEST_FRAME_ID, method, params },
        ).length + delta,
      );
    }
    client.stop();
  });
}

import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "./protocol/client-info.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";

function createFakeClient(params?: {
  caps?: string[];
  scopes?: string[];
  bufferedAmount?: number;
}) {
  const sent: unknown[] = [];
  const socket = {
    bufferedAmount: params?.bufferedAmount ?? 0,
    send: vi.fn((frame: string) => {
      sent.push(JSON.parse(frame));
    }),
    close: vi.fn(),
  };
  const client = {
    connId: "c1",
    connect: {
      role: "operator",
      scopes: params?.scopes ?? ["operator.admin"],
      caps: params?.caps ?? [],
    },
    socket,
  };
  return { client, socket, sent };
}

describe("server-broadcast", () => {
  it("does not sequence agent tool events", () => {
    const { client, sent } = createFakeClient({ caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS] });
    const clients = new Set([client as any]);
    const { broadcast } = createGatewayBroadcaster({ clients: clients as any });

    broadcast("chat", { hello: true });
    broadcast("agent", { stream: "tool", data: { phase: "start" } });
    broadcast("chat", { ok: true });

    const chat1 = sent[0] as any;
    const tool = sent[1] as any;
    const chat2 = sent[2] as any;

    expect(chat1.seq).toBe(1);
    expect(tool.seq).toBeUndefined();
    expect(chat2.seq).toBe(2);
  });

  it("filters agent tool events unless client has TOOL_EVENTS cap", () => {
    const a = createFakeClient({ caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS] });
    const b = createFakeClient({ caps: [] });

    const clients = new Set([a.client as any, b.client as any]);
    const { broadcast } = createGatewayBroadcaster({ clients: clients as any });

    broadcast("agent", { stream: "tool", data: { phase: "result" } });

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });
});

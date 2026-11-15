import { expect } from "vitest";
import { appsGatewayInitScript } from "../../scripts/route-leaks-apps-pilot.ts";
import type {
  ControlUiMockRequestHandler,
  MockGatewayWindow,
} from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { createControlUiMockGatewayInitScript } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  flushMockTimers,
  mockGatewayTest as it,
} from "../../ui/src/test-helpers/mock-gateway-page.test-support.ts";

type ProbeWindow = MockGatewayWindow & {
  appsCatalogProbe: {
    requests: Array<{ method: string; at: number }>;
    preparations: Array<{
      id: string;
      params: unknown;
      requestAt: number;
      response?: unknown;
      responseAt?: number;
    }>;
  };
};

it("observes each mock request and its own reply without changing socket contracts", async ({
  gatewayPage,
}) => {
  const { window, execute } = gatewayPage;
  const forwarded: Array<{ socket: PassthroughWebSocket; data: string }> = [];
  class PassthroughWebSocket extends window.EventTarget {
    static readonly CLOSED = 3;
    static readonly CLOSING = 2;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readonly url: string;
    readonly protocols: string | string[] | undefined;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = String(url);
      this.protocols = protocols;
    }

    send(data: string) {
      expect(this).toBeInstanceOf(PassthroughWebSocket);
      forwarded.push({ socket: this, data });
    }
  }
  window.WebSocket = PassthroughWebSocket as unknown as typeof WebSocket;
  execute(
    createControlUiMockGatewayInitScript({
      webSocketPassthroughPrefixes: ["ws://passthrough/"],
    }),
  );
  const gatewaySocket = window.WebSocket;
  execute(appsGatewayInitScript(""));
  expect(window.WebSocket.prototype).toBe(gatewaySocket.prototype);
  expect(window.WebSocket.OPEN).toBe(gatewaySocket.OPEN);
  expect(window.WebSocket.CLOSED).toBe(gatewaySocket.CLOSED);

  const probeWindow = window as unknown as ProbeWindow;
  const gateway = probeWindow.openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Mock Gateway was not installed");
  }
  const pending: Parameters<ControlUiMockRequestHandler>[0][] = [];
  gateway.setRequestHandler("sessions.create", (request) => pending.push(request));
  const sockets = [
    new window.WebSocket("ws://mock/first"),
    new window.WebSocket("ws://mock/second"),
  ];
  const replies: unknown[] = [];
  for (const socket of sockets) {
    expect(socket).toBeInstanceOf(window.WebSocket);
    socket.addEventListener("message", (event: MessageEvent) => {
      replies.push(JSON.parse(String(event.data)));
    });
  }
  await flushMockTimers();
  replies.length = 0;
  for (const [index, socket] of sockets.entries()) {
    socket.send(
      JSON.stringify({
        type: "req",
        id: String(index),
        method: "sessions.create",
        params: { agentId: "main" },
      }),
    );
  }
  await flushMockTimers();
  expect(pending).toHaveLength(2);
  pending[1]?.respond({ key: "agent:main:second" });
  pending[0]?.respond({ key: "agent:main:first" });

  const expectedReplies = [
    { type: "res", id: "1", ok: true, payload: { key: "agent:main:second" } },
    { type: "res", id: "0", ok: true, payload: { key: "agent:main:first" } },
  ];
  expect(replies).toEqual(expectedReplies);
  expect(probeWindow.appsCatalogProbe.requests.map((request) => request.method)).toEqual([
    "sessions.create",
    "sessions.create",
  ]);
  expect(probeWindow.appsCatalogProbe.preparations).toMatchObject([
    { id: "0", params: { agentId: "main" }, response: expectedReplies[1] },
    { id: "1", params: { agentId: "main" }, response: expectedReplies[0] },
  ]);
  for (const receipt of probeWindow.appsCatalogProbe.preparations) {
    expect(receipt.responseAt).toBeGreaterThanOrEqual(receipt.requestAt);
  }

  const passthrough = new window.WebSocket("ws://passthrough/source", "test-protocol");
  expect(passthrough).toBeInstanceOf(PassthroughWebSocket);
  passthrough.send("unchanged transport data");
  expect(forwarded).toEqual([{ socket: passthrough, data: "unchanged transport data" }]);
  expect(forwarded[0]?.socket.protocols).toBe("test-protocol");
});

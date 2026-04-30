import { Buffer } from "node:buffer";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { NodeMcpClientTransport } from "./node-mcp-client-transport.js";
import { NodeRegistry } from "./node-registry.js";
import type { ConnectParams } from "./protocol/index.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function createNodeClient(params: { nodeId?: string; caps?: string[]; mcpServers?: unknown[] }): {
  client: GatewayWsClient;
  sent: Array<{ event: string; payload: unknown }>;
} {
  const sent: Array<{ event: string; payload: unknown }> = [];
  const nodeId = params.nodeId ?? "mac-node";
  const connect: ConnectParams = {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "node-host",
      displayName: "Mac",
      version: "dev",
      platform: "macOS",
      mode: "node",
    },
    role: "node",
    scopes: [],
    caps: params.caps ?? ["mcpHost"],
    commands: [],
    mcpServers: params.mcpServers as ConnectParams["mcpServers"],
    device: {
      id: nodeId,
      publicKey: "public-key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    },
  };
  const socket = {
    send(data: string) {
      const frame = JSON.parse(data) as { event?: string; payload?: unknown };
      if (frame.event) {
        sent.push({ event: frame.event, payload: frame.payload });
      }
    },
  } as unknown as WebSocket;
  return {
    client: {
      socket,
      connect,
      connId: `${nodeId}-conn`,
      usesSharedGatewayAuth: false,
    },
    sent,
  };
}

function assignTransportHandlers(
  transport: NodeMcpClientTransport,
  handlers: Partial<Transport>,
): void {
  Object.assign(transport, handlers);
}

describe("NodeMcpClientTransport", () => {
  it("opens a declared node-hosted MCP server and forwards JSON-RPC over stdout", async () => {
    const registry = new NodeRegistry();
    const { client, sent } = createNodeClient({
      mcpServers: [{ id: "computer-use", displayName: "Computer Use", status: "ready" }],
    });
    registry.register(client, {});

    const transport = new NodeMcpClientTransport(registry, {
      nodeId: "mac-node",
      serverId: "computer-use",
      sessionId: "session-1",
      openTimeoutMs: 1000,
    });
    const messages: unknown[] = [];
    const onclose = vi.fn();
    assignTransportHandlers(transport, {
      onmessage: (message) => messages.push(message),
      onclose,
    });

    const start = transport.start();
    expect(sent).toEqual([
      {
        event: "node.mcp.session.open",
        payload: {
          sessionId: "session-1",
          nodeId: "mac-node",
          serverId: "computer-use",
          timeoutMs: 1000,
        },
      },
    ]);
    expect(
      registry.handleMcpSessionOpenResult({
        sessionId: "session-1",
        nodeId: "mac-node",
        serverId: "computer-use",
        ok: true,
        pid: 42,
      }),
    ).toBe(true);
    await start;

    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(sent.at(-1)?.event).toBe("node.mcp.session.input");
    const inputPayload = sent.at(-1)?.payload as { dataBase64?: string };
    expect(Buffer.from(inputPayload.dataBase64 ?? "", "base64").toString("utf8")).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
    );

    expect(
      registry.handleMcpSessionOutput({
        sessionId: "session-1",
        nodeId: "mac-node",
        seq: 0,
        stream: "stdout",
        dataBase64: Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n').toString(
          "base64",
        ),
      }),
    ).toBe(true);
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);

    await transport.close();
    expect(sent.at(-1)).toEqual({
      event: "node.mcp.session.close",
      payload: {
        sessionId: "session-1",
        nodeId: "mac-node",
        reason: "client_close",
      },
    });
    expect(
      registry.handleMcpSessionOutput({
        sessionId: "session-1",
        nodeId: "mac-node",
        seq: 1,
        stream: "stdout",
        dataBase64: Buffer.from('{"jsonrpc":"2.0","method":"stale"}\n').toString("base64"),
      }),
    ).toBe(false);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("rejects sessions for undeclared MCP servers before sending to the node", async () => {
    const registry = new NodeRegistry();
    const { client, sent } = createNodeClient({
      mcpServers: [{ id: "computer-use" }],
    });
    registry.register(client, {});

    const transport = new NodeMcpClientTransport(registry, {
      nodeId: "mac-node",
      serverId: "not-advertised",
      sessionId: "session-2",
      openTimeoutMs: 1,
    });

    await expect(transport.start()).rejects.toThrow("node did not advertise MCP server");
    expect(sent).toEqual([]);
  });

  it("closes pending open sessions when the caller closes before start resolves", async () => {
    const registry = new NodeRegistry();
    const { client, sent } = createNodeClient({
      mcpServers: [{ id: "computer-use", status: "ready" }],
    });
    registry.register(client, {});
    const transport = new NodeMcpClientTransport(registry, {
      nodeId: "mac-node",
      serverId: "computer-use",
      sessionId: "session-opening",
      openTimeoutMs: 1000,
    });
    const onclose = vi.fn();
    assignTransportHandlers(transport, { onclose });

    const start = transport.start();
    expect(sent).toEqual([
      {
        event: "node.mcp.session.open",
        payload: {
          sessionId: "session-opening",
          nodeId: "mac-node",
          serverId: "computer-use",
          timeoutMs: 1000,
        },
      },
    ]);

    await transport.close();

    expect(sent.at(-1)).toEqual({
      event: "node.mcp.session.close",
      payload: {
        sessionId: "session-opening",
        nodeId: "mac-node",
        reason: "client_close",
      },
    });
    await expect(start).rejects.toThrow("NodeMcpClientTransport is closed");
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(
      registry.handleMcpSessionOpenResult({
        sessionId: "session-opening",
        nodeId: "mac-node",
        serverId: "computer-use",
        ok: true,
      }),
    ).toBe(false);
    expect(
      registry.handleMcpSessionOutput({
        sessionId: "session-opening",
        nodeId: "mac-node",
        seq: 0,
        stream: "stdout",
        dataBase64: Buffer.from('{"jsonrpc":"2.0","method":"stale"}\n').toString("base64"),
      }),
    ).toBe(false);
  });

  it("rejects advertised MCP servers that are not ready", async () => {
    const registry = new NodeRegistry();
    const { client, sent } = createNodeClient({
      mcpServers: [{ id: "computer-use", status: "missing_permissions" }],
    });
    registry.register(client, {});

    const transport = new NodeMcpClientTransport(registry, {
      nodeId: "mac-node",
      serverId: "computer-use",
      sessionId: "session-not-ready",
      openTimeoutMs: 1,
    });

    await expect(transport.start()).rejects.toThrow("node MCP server is missing_permissions");
    expect(sent).toEqual([]);
  });

  it("closes active sessions when the node disconnects", async () => {
    const registry = new NodeRegistry();
    const { client } = createNodeClient({
      mcpServers: [{ id: "computer-use" }],
    });
    registry.register(client, {});
    const transport = new NodeMcpClientTransport(registry, {
      nodeId: "mac-node",
      serverId: "computer-use",
      sessionId: "session-3",
      openTimeoutMs: 1000,
    });
    const onclose = vi.fn();
    const onerror = vi.fn();
    assignTransportHandlers(transport, { onclose, onerror });

    const start = transport.start();
    registry.handleMcpSessionOpenResult({
      sessionId: "session-3",
      nodeId: "mac-node",
      serverId: "computer-use",
      ok: true,
    });
    await start;

    expect(registry.unregister(client.connId)).toBe("mac-node");
    expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: "node disconnected" }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

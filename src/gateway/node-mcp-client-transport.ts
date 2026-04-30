import { randomUUID } from "node:crypto";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { NodeMcpClosedResult, NodeMcpOutputChunk, NodeRegistry } from "./node-registry.js";

export type NodeMcpClientTransportOptions = {
  nodeId: string;
  serverId: string;
  sessionId?: string;
  openTimeoutMs?: number;
};

export class NodeMcpClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly readBuffer = new ReadBuffer();
  private readonly nodeMcpSessionId: string;
  private started = false;
  private closed = false;
  private seq = 0;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly options: NodeMcpClientTransportOptions,
  ) {
    this.nodeMcpSessionId = options.sessionId ?? randomUUID();
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("NodeMcpClientTransport already started");
    }
    if (this.closed) {
      throw new Error("NodeMcpClientTransport is closed");
    }
    const result = await this.registry.openMcpSession({
      nodeId: this.options.nodeId,
      serverId: this.options.serverId,
      sessionId: this.nodeMcpSessionId,
      timeoutMs: this.options.openTimeoutMs,
      onOutput: (chunk) => this.handleOutput(chunk),
      onClosed: (closed) => this.handleClosed(closed),
    });
    if (this.closed) {
      throw new Error("NodeMcpClientTransport is closed");
    }
    if (!result.ok) {
      const message = result.error?.message ?? "failed to open node MCP session";
      throw new Error(message);
    }
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed) {
      throw new Error("Not connected");
    }
    const payload = Buffer.from(serializeMessage(message), "utf8").toString("base64");
    const sent = this.registry.sendMcpInput({
      nodeId: this.options.nodeId,
      sessionId: this.nodeMcpSessionId,
      seq: this.seq++,
      dataBase64: payload,
    });
    if (!sent) {
      throw new Error("failed to send node MCP input");
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readBuffer.clear();
    this.registry.closeMcpSession({
      nodeId: this.options.nodeId,
      sessionId: this.nodeMcpSessionId,
      reason: "client_close",
    });
    this.onclose?.();
  }

  private handleOutput(chunk: NodeMcpOutputChunk) {
    if (this.closed) {
      return;
    }
    if (chunk.stream !== "stdout") {
      return;
    }
    try {
      this.readBuffer.append(Buffer.from(chunk.dataBase64, "base64"));
      while (true) {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          break;
        }
        this.onmessage?.(message);
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleClosed(result: NodeMcpClosedResult) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readBuffer.clear();
    if (!result.ok) {
      const message = result.error?.message ?? "node MCP session closed";
      this.onerror?.(new Error(message));
    }
    this.onclose?.();
  }
}

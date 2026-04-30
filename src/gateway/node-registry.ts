import { randomUUID } from "node:crypto";
import {
  normalizeNodeMcpServerDescriptors,
  type NodeMcpServerDescriptor,
} from "../shared/node-mcp-types.js";
import type { GatewayWsClient } from "./server/ws-types.js";

export type NodeMcpOutputChunk = {
  sessionId: string;
  nodeId: string;
  seq: number;
  stream: "stdout" | "stderr";
  dataBase64: string;
};

export type NodeMcpClosedResult = {
  sessionId: string;
  nodeId: string;
  ok: boolean;
  exitCode?: number | null;
  signal?: string | null;
  error?: { code?: string; message?: string } | null;
};

export type NodeMcpOpenResult = {
  sessionId: string;
  nodeId: string;
  serverId: string;
  ok: boolean;
  pid?: number;
  error?: { code?: string; message?: string } | null;
};

export type NodeSession = {
  nodeId: string;
  connId: string;
  client: GatewayWsClient;
  clientId?: string;
  clientMode?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  caps: string[];
  commands: string[];
  mcpServers?: NodeMcpServerDescriptor[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
};

type PendingInvoke = {
  nodeId: string;
  command: string;
  resolve: (value: NodeInvokeResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingMcpOpen = {
  nodeId: string;
  serverId: string;
  resolve: (value: NodeMcpOpenResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ActiveMcpSession = {
  nodeId: string;
  serverId: string;
  onOutput?: (chunk: NodeMcpOutputChunk) => void;
  onClosed?: (result: NodeMcpClosedResult) => void;
};

export type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

export class NodeRegistry {
  private nodesById = new Map<string, NodeSession>();
  private nodesByConn = new Map<string, string>();
  private pendingInvokes = new Map<string, PendingInvoke>();
  private pendingMcpOpens = new Map<string, PendingMcpOpen>();
  private activeMcpSessions = new Map<string, ActiveMcpSession>();

  register(client: GatewayWsClient, opts: { remoteIp?: string | undefined }) {
    const connect = client.connect;
    const nodeId = connect.device?.id ?? connect.client.id;
    const caps = Array.isArray(connect.caps) ? connect.caps : [];
    const commands = Array.isArray((connect as { commands?: string[] }).commands)
      ? ((connect as { commands?: string[] }).commands ?? [])
      : [];
    const permissions =
      typeof (connect as { permissions?: Record<string, boolean> }).permissions === "object"
        ? ((connect as { permissions?: Record<string, boolean> }).permissions ?? undefined)
        : undefined;
    const pathEnv =
      typeof (connect as { pathEnv?: string }).pathEnv === "string"
        ? (connect as { pathEnv?: string }).pathEnv
        : undefined;
    const mcpServers = normalizeNodeMcpServerDescriptors(
      (connect as { mcpServers?: unknown }).mcpServers,
    );
    const session: NodeSession = {
      nodeId,
      connId: client.connId,
      client,
      clientId: connect.client.id,
      clientMode: connect.client.mode,
      displayName: connect.client.displayName,
      platform: connect.client.platform,
      version: connect.client.version,
      coreVersion: (connect as { coreVersion?: string }).coreVersion,
      uiVersion: (connect as { uiVersion?: string }).uiVersion,
      deviceFamily: connect.client.deviceFamily,
      modelIdentifier: connect.client.modelIdentifier,
      remoteIp: opts.remoteIp,
      caps,
      commands,
      mcpServers,
      permissions,
      pathEnv,
      connectedAtMs: Date.now(),
    };
    this.nodesById.set(nodeId, session);
    this.nodesByConn.set(client.connId, nodeId);
    return session;
  }

  unregister(connId: string): string | null {
    const nodeId = this.nodesByConn.get(connId);
    if (!nodeId) {
      return null;
    }
    this.nodesByConn.delete(connId);
    this.nodesById.delete(nodeId);
    for (const [id, pending] of this.pendingInvokes.entries()) {
      if (pending.nodeId !== nodeId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.reject(new Error(`node disconnected (${pending.command})`));
      this.pendingInvokes.delete(id);
    }
    for (const [sessionId, pending] of this.pendingMcpOpens.entries()) {
      if (pending.nodeId !== nodeId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.resolve({
        sessionId,
        nodeId,
        serverId: pending.serverId,
        ok: false,
        error: { code: "NODE_DISCONNECTED", message: "node disconnected" },
      });
      this.pendingMcpOpens.delete(sessionId);
    }
    for (const [sessionId, session] of this.activeMcpSessions.entries()) {
      if (session.nodeId !== nodeId) {
        continue;
      }
      this.activeMcpSessions.delete(sessionId);
      session.onClosed?.({
        sessionId,
        nodeId,
        ok: false,
        error: { code: "NODE_DISCONNECTED", message: "node disconnected" },
      });
    }
    return nodeId;
  }

  listConnected(): NodeSession[] {
    return [...this.nodesById.values()];
  }

  get(nodeId: string): NodeSession | undefined {
    return this.nodesById.get(nodeId);
  }

  async invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<NodeInvokeResult> {
    const node = this.nodesById.get(params.nodeId);
    if (!node) {
      return {
        ok: false,
        error: { code: "NOT_CONNECTED", message: "node not connected" },
      };
    }
    const requestId = randomUUID();
    const payload = {
      id: requestId,
      nodeId: params.nodeId,
      command: params.command,
      paramsJSON:
        "params" in params && params.params !== undefined ? JSON.stringify(params.params) : null,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    };
    const ok = this.sendEventToSession(node, "node.invoke.request", payload);
    if (!ok) {
      return {
        ok: false,
        error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
      };
    }
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;
    return await new Promise<NodeInvokeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(requestId);
        resolve({
          ok: false,
          error: { code: "TIMEOUT", message: "node invoke timed out" },
        });
      }, timeoutMs);
      this.pendingInvokes.set(requestId, {
        nodeId: params.nodeId,
        command: params.command,
        resolve,
        reject,
        timer,
      });
    });
  }

  handleInvokeResult(params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  }): boolean {
    const pending = this.pendingInvokes.get(params.id);
    if (!pending) {
      return false;
    }
    if (pending.nodeId !== params.nodeId) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingInvokes.delete(params.id);
    pending.resolve({
      ok: params.ok,
      payload: params.payload,
      payloadJSON: params.payloadJSON ?? null,
      error: params.error ?? null,
    });
    return true;
  }

  sendEvent(nodeId: string, event: string, payload?: unknown): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return false;
    }
    return this.sendEventToSession(node, event, payload);
  }

  async openMcpSession(params: {
    nodeId: string;
    serverId: string;
    sessionId?: string;
    timeoutMs?: number;
    onOutput?: (chunk: NodeMcpOutputChunk) => void;
    onClosed?: (result: NodeMcpClosedResult) => void;
  }): Promise<NodeMcpOpenResult> {
    const node = this.nodesById.get(params.nodeId);
    const sessionId = params.sessionId ?? randomUUID();
    if (!node) {
      return {
        sessionId,
        nodeId: params.nodeId,
        serverId: params.serverId,
        ok: false,
        error: { code: "NOT_CONNECTED", message: "node not connected" },
      };
    }
    if (!node.caps.includes("mcpHost")) {
      return {
        sessionId,
        nodeId: params.nodeId,
        serverId: params.serverId,
        ok: false,
        error: { code: "MCP_HOST_UNAVAILABLE", message: "node did not advertise mcpHost" },
      };
    }
    const descriptors = node.mcpServers ?? [];
    const descriptor = descriptors.find((entry) => entry.id === params.serverId);
    if (!descriptor) {
      return {
        sessionId,
        nodeId: params.nodeId,
        serverId: params.serverId,
        ok: false,
        error: { code: "MCP_SERVER_NOT_DECLARED", message: "node did not advertise MCP server" },
      };
    }
    if (descriptor.status && descriptor.status !== "ready") {
      return {
        sessionId,
        nodeId: params.nodeId,
        serverId: params.serverId,
        ok: false,
        error: {
          code: "MCP_SERVER_NOT_READY",
          message: `node MCP server is ${descriptor.status}`,
        },
      };
    }
    this.activeMcpSessions.set(sessionId, {
      nodeId: params.nodeId,
      serverId: params.serverId,
      onOutput: params.onOutput,
      onClosed: params.onClosed,
    });
    const ok = this.sendEventToSession(node, "node.mcp.session.open", {
      sessionId,
      nodeId: params.nodeId,
      serverId: params.serverId,
      timeoutMs: params.timeoutMs,
    });
    if (!ok) {
      this.activeMcpSessions.delete(sessionId);
      return {
        sessionId,
        nodeId: params.nodeId,
        serverId: params.serverId,
        ok: false,
        error: { code: "UNAVAILABLE", message: "failed to send MCP session open to node" },
      };
    }
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;
    return await new Promise<NodeMcpOpenResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingMcpOpens.delete(sessionId);
        this.activeMcpSessions.delete(sessionId);
        resolve({
          sessionId,
          nodeId: params.nodeId,
          serverId: params.serverId,
          ok: false,
          error: { code: "TIMEOUT", message: "node MCP session open timed out" },
        });
      }, timeoutMs);
      this.pendingMcpOpens.set(sessionId, {
        nodeId: params.nodeId,
        serverId: params.serverId,
        resolve,
        timer,
      });
    });
  }

  handleMcpSessionOpenResult(params: NodeMcpOpenResult): boolean {
    const pending = this.pendingMcpOpens.get(params.sessionId);
    if (!pending) {
      return false;
    }
    if (pending.nodeId !== params.nodeId || pending.serverId !== params.serverId) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingMcpOpens.delete(params.sessionId);
    if (!params.ok) {
      this.activeMcpSessions.delete(params.sessionId);
    }
    pending.resolve({
      sessionId: params.sessionId,
      nodeId: params.nodeId,
      serverId: params.serverId,
      ok: params.ok,
      pid: params.pid,
      error: params.error ?? null,
    });
    return true;
  }

  sendMcpInput(params: {
    sessionId: string;
    nodeId: string;
    seq: number;
    dataBase64: string;
  }): boolean {
    const active = this.activeMcpSessions.get(params.sessionId);
    if (!active || active.nodeId !== params.nodeId) {
      return false;
    }
    return this.sendEvent(params.nodeId, "node.mcp.session.input", params);
  }

  closeMcpSession(params: { sessionId: string; nodeId: string; reason?: string }): boolean {
    const active = this.activeMcpSessions.get(params.sessionId);
    if (!active || active.nodeId !== params.nodeId) {
      return false;
    }
    this.activeMcpSessions.delete(params.sessionId);
    const pending = this.pendingMcpOpens.get(params.sessionId);
    if (pending && pending.nodeId === params.nodeId) {
      clearTimeout(pending.timer);
      this.pendingMcpOpens.delete(params.sessionId);
      pending.resolve({
        sessionId: params.sessionId,
        nodeId: params.nodeId,
        serverId: pending.serverId,
        ok: false,
        error: {
          code: "CLIENT_CLOSED",
          message: "node MCP session closed before open completed",
        },
      });
    }
    return this.sendEvent(params.nodeId, "node.mcp.session.close", params);
  }

  handleMcpSessionOutput(params: NodeMcpOutputChunk): boolean {
    const active = this.activeMcpSessions.get(params.sessionId);
    if (!active || active.nodeId !== params.nodeId) {
      return false;
    }
    active.onOutput?.(params);
    return true;
  }

  handleMcpSessionClosed(params: NodeMcpClosedResult): boolean {
    const active = this.activeMcpSessions.get(params.sessionId);
    if (!active || active.nodeId !== params.nodeId) {
      return false;
    }
    this.activeMcpSessions.delete(params.sessionId);
    active.onClosed?.(params);
    return true;
  }

  private sendEventInternal(node: NodeSession, event: string, payload: unknown): boolean {
    try {
      node.client.socket.send(
        JSON.stringify({
          type: "event",
          event,
          payload,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private sendEventToSession(node: NodeSession, event: string, payload: unknown): boolean {
    return this.sendEventInternal(node, event, payload);
  }
}

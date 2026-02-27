import { randomUUID } from "node:crypto";
import type { NodeBillingMode } from "../config/types.gateway.js";
import type { KVNodeSync, RemoteNodeInfo, InvokeRequest } from "./kv-node-sync.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { marketplaceEventBus } from "./marketplace/event-bus.js";

export type NodeSession = {
  nodeId: string;
  connId: string;
  client: GatewayWsClient;
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
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
  /** Billing mode for this node (default: "global"). */
  billingMode?: NodeBillingMode;
  /** Dedicated budget in cents (only used when billingMode is "dedicated"). */
  dedicatedBudgetCents?: number;
  /** Running total of cents spent (dedicated mode, persisted via config). */
  dedicatedSpentCents?: number;
  /** Whether this node has opted into marketplace P2P sharing. */
  marketplaceEnabled?: boolean;
  /** Marketplace idle status: active, idle, or sharing. */
  marketplaceStatus?: "active" | "idle" | "sharing";
  /** Number of active marketplace proxy requests on this node. */
  marketplaceActiveRequests?: number;
  /** Maximum concurrent marketplace requests this node accepts. */
  marketplaceMaxConcurrent?: number;
  /** Seller's payout preference: USD or $AI token. */
  marketplacePayoutPreference?: "usd" | "ai_token";
};

type PendingInvoke = {
  nodeId: string;
  command: string;
  resolve: (value: NodeInvokeResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

/** Lightweight node info returned by listAll (may be remote). */
export type NodeInfo = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps: string[];
  commands: string[];
  connectedAtMs: number;
  remoteIp?: string;
  pathEnv?: string;
  permissions?: Record<string, boolean>;
  connected: boolean;
  local: boolean;
  podId?: string;
  billingMode?: NodeBillingMode;
  dedicatedBudgetCents?: number;
  dedicatedSpentCents?: number;
};

export class NodeRegistry {
  private nodesById = new Map<string, NodeSession>();
  private nodesByConn = new Map<string, string>();
  private pendingInvokes = new Map<string, PendingInvoke>();

  /** Optional KV sync for cross-pod node sharing. */
  private sync: KVNodeSync | null = null;

  /** Attach Hanzo KV sync layer for cross-pod node sharing. */
  setSync(sync: KVNodeSync): void {
    this.sync = sync;

    // Handle invoke requests routed from other pods.
    sync.onInvokeRequest((req: InvokeRequest) => {
      const node = this.nodesById.get(req.nodeId);
      if (!node) {
        return;
      }

      // Execute the invoke locally and route result back.
      void this.invoke({
        nodeId: req.nodeId,
        command: req.command,
        params: req.params,
        timeoutMs: req.timeoutMs,
        idempotencyKey: req.idempotencyKey,
      }).then((result) => {
        void sync.routeInvokeResult(req.originPodId, {
          requestId: req.requestId,
          originPodId: req.originPodId,
          ok: result.ok,
          payload: result.payload,
          payloadJSON: result.payloadJSON ?? null,
          error: result.error ?? null,
        });
      });
    });

    // Handle invoke results routed back from other pods.
    sync.onInvokeResult((result) => {
      const pending = this.pendingInvokes.get(result.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingInvokes.delete(result.requestId);
      pending.resolve({
        ok: result.ok,
        payload: result.payload,
        payloadJSON: result.payloadJSON ?? null,
        error: result.error ?? null,
      });
    });
  }

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
    const session: NodeSession = {
      nodeId,
      connId: client.connId,
      client,
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
      permissions,
      pathEnv,
      connectedAtMs: Date.now(),
    };
    // Detect marketplace capability from node's advertised caps.
    if (caps.includes("marketplace")) {
      session.marketplaceEnabled = true;
      session.marketplaceStatus = "active";
      session.marketplaceActiveRequests = 0;
      session.marketplaceMaxConcurrent = 1;
      // Notify the marketplace scheduler so it tracks this seller immediately.
      marketplaceEventBus.emitIdleStatus({
        nodeId,
        status: "active",
        maxConcurrent: 1,
      });
    }
    this.nodesById.set(nodeId, session);
    this.nodesByConn.set(client.connId, nodeId);

    // Sync to KV for cross-pod visibility.
    if (this.sync) {
      void this.sync.publishNode(nodeId, {
        displayName: session.displayName,
        platform: session.platform,
        version: session.version,
        caps,
        commands,
        connectedAtMs: session.connectedAtMs,
        remoteIp: session.remoteIp,
      });
    }

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

    // Remove from KV.
    if (this.sync) {
      void this.sync.removeNode(nodeId);
    }

    return nodeId;
  }

  listConnected(): NodeSession[] {
    return [...this.nodesById.values()];
  }

  /** List all nodes across all pods (local + remote via KV). */
  async listAll(): Promise<NodeInfo[]> {
    const localNodes = this.listConnected();

    if (!this.sync) {
      // No KV — return local only.
      return localNodes.map((n) => ({
        nodeId: n.nodeId,
        displayName: n.displayName,
        platform: n.platform,
        version: n.version,
        coreVersion: n.coreVersion,
        uiVersion: n.uiVersion,
        deviceFamily: n.deviceFamily,
        modelIdentifier: n.modelIdentifier,
        caps: n.caps,
        commands: n.commands,
        connectedAtMs: n.connectedAtMs,
        remoteIp: n.remoteIp,
        pathEnv: n.pathEnv,
        permissions: n.permissions,
        connected: true,
        local: true,
        billingMode: n.billingMode,
        dedicatedBudgetCents: n.dedicatedBudgetCents,
        dedicatedSpentCents: n.dedicatedSpentCents,
      }));
    }

    // Merge local + remote from KV.
    const remoteNodes = await this.sync.listAllNodes();
    const seen = new Set<string>();
    const result: NodeInfo[] = [];

    // Local nodes first (authoritative — they have the WS connection).
    for (const n of localNodes) {
      seen.add(n.nodeId);
      result.push({
        nodeId: n.nodeId,
        displayName: n.displayName,
        platform: n.platform,
        version: n.version,
        coreVersion: n.coreVersion,
        uiVersion: n.uiVersion,
        deviceFamily: n.deviceFamily,
        modelIdentifier: n.modelIdentifier,
        caps: n.caps,
        commands: n.commands,
        connectedAtMs: n.connectedAtMs,
        remoteIp: n.remoteIp,
        pathEnv: n.pathEnv,
        permissions: n.permissions,
        connected: true,
        local: true,
        podId: this.sync.podId,
        billingMode: n.billingMode,
        dedicatedBudgetCents: n.dedicatedBudgetCents,
        dedicatedSpentCents: n.dedicatedSpentCents,
      });
    }

    // Remote nodes from other pods.
    for (const r of remoteNodes) {
      if (seen.has(r.nodeId)) {
        continue;
      }
      seen.add(r.nodeId);
      result.push({
        nodeId: r.nodeId,
        displayName: r.displayName,
        platform: r.platform,
        version: r.version,
        caps: r.caps,
        commands: r.commands,
        connectedAtMs: r.connectedAtMs,
        remoteIp: r.remoteIp,
        connected: true,
        local: false,
        podId: r.podId,
      });
    }

    return result;
  }

  get(nodeId: string): NodeSession | undefined {
    return this.nodesById.get(nodeId);
  }

  /** Look up a node on another pod via KV. Returns null if not found or no sync layer. */
  async getRemoteNode(nodeId: string): Promise<RemoteNodeInfo | null> {
    if (!this.sync) {
      return null;
    }
    return this.sync.getNode(nodeId);
  }

  async invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<NodeInvokeResult> {
    const node = this.nodesById.get(params.nodeId);

    // Node is on this pod — invoke directly.
    if (node) {
      return this.invokeLocal(node, params);
    }

    // Node might be on another pod — route via KV pub/sub.
    if (this.sync) {
      const remote = await this.sync.getNode(params.nodeId);
      if (remote) {
        return this.invokeRemote(remote, params);
      }
    }

    return {
      ok: false,
      error: { code: "NOT_CONNECTED", message: "node not connected" },
    };
  }

  private async invokeLocal(
    node: NodeSession,
    params: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey?: string;
    },
  ): Promise<NodeInvokeResult> {
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

  private async invokeRemote(
    remote: RemoteNodeInfo,
    params: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey?: string;
    },
  ): Promise<NodeInvokeResult> {
    if (!this.sync) {
      return { ok: false, error: { code: "NOT_CONNECTED", message: "no sync layer" } };
    }

    const requestId = randomUUID();
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;

    // Store pending invoke locally — result will arrive via pub/sub.
    const promise = new Promise<NodeInvokeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(requestId);
        resolve({
          ok: false,
          error: { code: "TIMEOUT", message: "remote node invoke timed out" },
        });
      }, timeoutMs);
      this.pendingInvokes.set(requestId, {
        nodeId: params.nodeId,
        command: params.command,
        resolve,
        reject: () => {},
        timer,
      });
    });

    // Route to the pod that owns the node.
    await this.sync.routeInvoke(remote.podId, {
      requestId,
      originPodId: this.sync.podId,
      nodeId: params.nodeId,
      command: params.command,
      params: params.params,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    });

    return promise;
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

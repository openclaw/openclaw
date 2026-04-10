// Octopus Orchestrator -- Node Agent Gateway client (M4-04)
//
// Interface-driven WS client representing the Node Agent's connection to
// the OpenClaw Gateway as a `role: node` client. The actual transport is
// injected via GatewayTransport so production code can plug in the real
// WebSocket and tests can use a mock.
//
// References:
//   - LLD.md SS"Head <-> Node Agent Wire Contract" SS"Connect frame"
//   - LLD.md SS"Request methods (Head -> Node Agent)"
//   - LLD.md SS"Push events (Node Agent -> Head)"
//   - wire/events.ts -- OctoLeaseRenewPushSchema
//   - DECISIONS.md OCTO-DEC-033 -- boundary discipline

// ──────────────────────────────────────────────────────────────────────────
// GatewayTransport -- injectable transport abstraction
// ──────────────────────────────────────────────────────────────────────────

/** Parameters for the connect frame sent to the Gateway. */
export interface ConnectParams {
  role: string;
  deviceId: string;
  platform: string;
  deviceFamily: string;
  auth: { token: string };
  caps: Record<string, unknown>;
  commands: string[];
}

/**
 * Transport abstraction over the Gateway WebSocket. Production code
 * supplies a real WS implementation; tests supply a mock.
 */
export interface GatewayTransport {
  connect(params: ConnectParams): Promise<void>;
  send(method: string, payload: unknown): Promise<unknown>;
  onPush(handler: (event: string, data: unknown) => void): void;
  close(): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────────
// Incoming method handler type
// ──────────────────────────────────────────────────────────────────────────

export type IncomingMethodHandler = (payload: unknown) => Promise<unknown>;

// ──────────────────────────────────────────────────────────────────────────
// Lease entry (matches OctoLeaseRenewPush.leases[n] shape)
// ──────────────────────────────────────────────────────────────────────────

export interface LeaseEntry {
  arm_id: string;
  lease_expiry_ts: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Supported incoming methods (Head -> Node Agent)
// ──────────────────────────────────────────────────────────────────────────

const OCTO_INCOMING_METHODS: readonly string[] = [
  "octo.arm.spawn",
  "octo.arm.attach",
  "octo.arm.send",
  "octo.arm.checkpoint",
  "octo.arm.terminate",
  "octo.arm.health",
  "octo.node.capabilities",
  "octo.node.reconcile",
] as const;

// ──────────────────────────────────────────────────────────────────────────
// NodeAgentGatewayClient
// ──────────────────────────────────────────────────────────────────────────

export class NodeAgentGatewayClient {
  private readonly transport: GatewayTransport;
  private readonly nodeId: string;
  private readonly capabilities: string[];
  private readonly adapters: string[];
  private readonly handlers = new Map<string, IncomingMethodHandler>();
  private connected = false;

  constructor(
    transport: GatewayTransport,
    nodeId: string,
    capabilities: string[],
    adapters: string[],
  ) {
    this.transport = transport;
    this.nodeId = nodeId;
    this.capabilities = capabilities;
    this.adapters = adapters;
  }

  /**
   * Connect to the Gateway with `role: node`, advertising octo caps and
   * the full set of supported incoming commands. Wires up the push
   * handler for incoming method dispatch.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      throw new Error("NodeAgentGatewayClient: already connected");
    }

    const params: ConnectParams = {
      role: "node",
      deviceId: this.nodeId,
      platform: process.platform,
      deviceFamily: process.platform === "darwin" ? "mac" : "other",
      auth: { token: "" }, // Populated by caller or transport layer
      caps: {
        octo: {
          version: "1",
          adapters: this.adapters,
        },
      },
      commands: [...OCTO_INCOMING_METHODS],
    };

    await this.transport.connect(params);

    // Wire incoming push dispatch.
    this.transport.onPush((event: string, data: unknown) => {
      const handler = this.handlers.get(event);
      if (handler !== undefined) {
        void handler(data);
      }
    });

    this.connected = true;
  }

  /**
   * Register a handler for an incoming method (Head -> Node Agent).
   */
  onMethod(method: string, handler: IncomingMethodHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Send a lease renew push to the Head. Formats the payload to match
   * OctoLeaseRenewPushSchema from wire/events.ts.
   */
  async sendLeaseRenew(leases: LeaseEntry[]): Promise<void> {
    if (!this.connected) {
      throw new Error("NodeAgentGatewayClient: not connected");
    }
    if (leases.length === 0) {
      throw new Error("NodeAgentGatewayClient: leases must not be empty");
    }

    await this.transport.send("octo.lease.renew", {
      node_id: this.nodeId,
      ts: new Date().toISOString(),
      leases,
    });
  }

  /**
   * Dispatch an incoming method call from the Head. Routes to the
   * registered handler for the method. Throws if no handler is
   * registered or if the method is unknown.
   */
  async dispatchIncoming(method: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (handler === undefined) {
      throw new Error(`NodeAgentGatewayClient: no handler for method "${method}"`);
    }
    return handler(payload);
  }

  /**
   * Disconnect from the Gateway.
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }
    await this.transport.close();
    this.connected = false;
  }

  /** Whether the client is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }
}

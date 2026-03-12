/**
 * Abstract transport layer for inter-agent communication.
 *
 * Phase 1: Interface definition.
 * The default implementation (WebSocketTransport) wraps the existing
 * callGateway() RPC so behaviour is unchanged.  Future backends
 * (Redis Streams, Kafka, …) implement the same contract.
 */

// ── Message types ──────────────────────────────────────────────

export interface AgentMessage {
  sessionKey: string;
  message: string;
  runId: string;
  provenance?: { kind: "inter_session" | "spawn" | "broadcast" };
  metadata?: Record<string, unknown>;
}

export interface AgentReply {
  runId: string;
  status: "ok" | "timeout" | "error";
  reply?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export type MessageHandler = (msg: AgentMessage) => Promise<void>;
export type Unsubscribe = () => void;

// ── Resolve params ────────────────────────────────────────────

export interface ResolveSessionParams {
  label?: string;
  sessionKey?: string;
  sessionId?: string;
}

// ── Transport interface ────────────────────────────────────────

export interface AgentTransport {
  /** Send a message to a specific session (fire-and-forget). */
  send(msg: AgentMessage): Promise<{ runId: string; status: "accepted" }>;

  /** Send a message and block until the run completes or times out. */
  sendAndWait(msg: AgentMessage, timeoutMs: number): Promise<AgentReply>;

  /** Subscribe to messages arriving at `sessionKey`. */
  subscribe(sessionKey: string, handler: MessageHandler): Unsubscribe;

  /** Broadcast an event to all connected clients / consumers. */
  broadcast(event: string, payload: unknown): void;

  /** Resolve a session key from a label, alias, or sessionId. */
  resolveSession(params: ResolveSessionParams): Promise<{ key: string }>;

  /** Wait for an already-started run to complete. */
  waitForRun(runId: string, timeoutMs: number): Promise<AgentReply>;

  /** Lifecycle — start the transport (connect, subscribe, etc.). */
  start(): Promise<void>;

  /** Lifecycle — graceful shutdown. */
  stop(): Promise<void>;
}

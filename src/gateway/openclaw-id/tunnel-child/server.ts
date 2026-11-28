// Tunnel server: accepts iroh connections on ALPN openclaw/tunnel/1, admits a
// peer only if the Gateway's latest membership push lists its key (checked
// before any stream is accepted), and proxies each bidirectional stream to the
// Gateway ingress socket as HTTP or WebSocket. Nothing is admitted before the
// first membership push: the Gateway is the membership authority.
import {
  CONNECTION_CLOSE,
  HEAD_TIMEOUT_MS,
  MAX_CONCURRENT_STREAMS,
  MAX_HEAD_FRAME_BYTES,
  parseRequestHead,
  SHUTDOWN_GRACE_MS,
  STREAM_RESET,
  syntheticPeerAddress,
  TUNNEL_ALPN,
  type IrohEndpointKey,
  type TunnelRequestHead,
} from "../../../../packages/openclaw-id-protocol/src/index.js";
import type { IrohConnection, IrohEndpoint, IrohRecvStream, IrohSendStream } from "./addon.js";
import { FrameReader } from "./frames.js";
import { upstreamHeaders } from "./headers.js";
import { proxyHttp, type GatewayIngressTarget } from "./http-proxy.js";
import { logFingerprint } from "./keyfile.js";
import { proxyWs } from "./ws-proxy.js";

/** The ALPN as bytes for `bind`. */
export const TUNNEL_ALPN_BYTES = new TextEncoder().encode(TUNNEL_ALPN);

/** Accept loop, admission, connection registry and stream dispatch. */
export class IngressServer {
  private readonly conns = new Map<string, Set<IrohConnection>>();
  private admitted = new Set<string>();
  private stopping = false;

  constructor(
    private readonly params: {
      endpoint: IrohEndpoint;
      target: GatewayIngressTarget;
      proxyToken: string;
      forwardedProto: "http" | "https";
      log: (message: string) => void;
      onConnectionsChanged?: (count: number) => void;
      idleMs?: number;
    },
  ) {}

  /**
   * Replaces the admitted peer keys and closes every live connection whose key
   * is no longer admitted with `revoked`.
   */
  setMembership(admitted: readonly string[]): void {
    this.admitted = new Set(admitted);
    for (const [peerKey, set] of this.conns) {
      if (!this.admitted.has(peerKey)) {
        this.conns.delete(peerKey);
        for (const conn of set) {
          conn.close(CONNECTION_CLOSE.revoked, "revoked");
        }
        this.params.log(
          `peer removed: peer=${logFingerprint(hexOf(peerKey))} closed_conns=${set.size}`,
        );
        this.notifyConnections();
      }
    }
  }

  /** Live connections across all peers. */
  connectionCount(): number {
    let count = 0;
    for (const set of this.conns.values()) {
      count += set.size;
    }
    return count;
  }

  /** Accepts connections until the endpoint closes. */
  async run(): Promise<void> {
    for (;;) {
      let conn: IrohConnection | null;
      try {
        conn = await this.params.endpoint.accept();
      } catch {
        // A failed handshake rejects this accept only; keep serving.
        continue;
      }
      if (!conn) {
        return;
      }
      this.handleConnection(conn).catch((error: unknown) =>
        this.params.log(`connection error: ${short(error)}`),
      );
    }
  }

  /** Closes every connection with `shutdown` and the endpoint, waiting at most 2 s. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const set of this.conns.values()) {
      for (const conn of set) {
        conn.close(CONNECTION_CLOSE.shutdown, "shutdown");
      }
    }
    this.conns.clear();
    await Promise.race([
      this.params.endpoint.close(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_GRACE_MS).unref();
      }),
    ]);
  }

  // Admits or refuses the authenticated peer before any stream, then serves streams.
  private async handleConnection(conn: IrohConnection): Promise<void> {
    const hex = conn.remoteId();
    // SAFETY: remoteId() is the 64-hex endpoint id, so iroh:<hex> is the formatted key.
    const peerKey = `iroh:${hex}` as IrohEndpointKey;
    const fp = logFingerprint(hex);
    if (this.stopping || !this.admitted.has(peerKey)) {
      conn.close(CONNECTION_CLOSE.not_a_member, "not a member");
      this.params.log(`admission rejected: peer=${fp}`);
      return;
    }
    conn.setMaxConcurrentBiStreams(MAX_CONCURRENT_STREAMS);
    this.track(peerKey, conn);
    this.params.log(`admission allowed: peer=${fp} path=${conn.pathKind()}`);
    const peerAddress = await syntheticPeerAddress(peerKey);
    await this.serveStreams(conn, peerKey, peerAddress, fp);
  }

  // Remembers conn under its key until it closes, for revocation and status.
  private track(peerKey: string, conn: IrohConnection): void {
    let set = this.conns.get(peerKey);
    if (!set) {
      set = new Set();
      this.conns.set(peerKey, set);
    }
    set.add(conn);
    this.notifyConnections();
    void conn.closed().then(() => {
      this.conns.get(peerKey)?.delete(conn);
      if (this.conns.get(peerKey)?.size === 0) {
        this.conns.delete(peerKey);
      }
      this.notifyConnections();
    });
  }

  private notifyConnections(): void {
    this.params.onConnectionsChanged?.(this.connectionCount());
  }

  // Accepts streams while at most MAX_CONCURRENT_STREAMS run; QUIC stream credit
  // (setMaxConcurrentBiStreams) queues further client opens instead of resetting them.
  private async serveStreams(
    conn: IrohConnection,
    peerKey: IrohEndpointKey,
    peerAddress: string,
    fp: string,
  ): Promise<void> {
    const slots = new Slots(MAX_CONCURRENT_STREAMS);
    for (;;) {
      await slots.acquire();
      let bi: { send: IrohSendStream; recv: IrohRecvStream };
      try {
        bi = await conn.acceptBi();
      } catch {
        return;
      }
      this.handleStream(conn, bi, peerKey, peerAddress, fp)
        .catch((error: unknown) => this.params.log(`stream error peer=${fp}: ${short(error)}`))
        .finally(() => slots.release());
    }
  }

  // Reads the HEAD frame, re-checks admission and dispatches to a proxy.
  private async handleStream(
    conn: IrohConnection,
    bi: { send: IrohSendStream; recv: IrohRecvStream },
    peerKey: IrohEndpointKey,
    peerAddress: string,
    fp: string,
  ): Promise<void> {
    const reader = new FrameReader(bi.recv);
    const head = await readHead(reader);
    if (!head) {
      await bi.send.reset(STREAM_RESET.bad_request).catch(() => {});
      return;
    }
    if (!this.admitted.has(peerKey)) {
      conn.close(CONNECTION_CLOSE.revoked, "revoked");
      return;
    }
    const headers = upstreamHeaders(
      head.headers,
      {
        peerKey,
        proxyToken: this.params.proxyToken,
        peerAddress,
        forwardedProto: this.params.forwardedProto,
      },
      head.kind,
    );
    const startedAt = Date.now();
    const status =
      head.kind === "ws"
        ? await proxyWs({ head, reader, send: bi.send, headers, target: this.params.target })
        : await proxyHttp({
            head,
            reader,
            send: bi.send,
            headers,
            target: this.params.target,
            idleMs: this.params.idleMs,
          });
    const method = head.kind === "http" ? head.method : "GET";
    this.params.log(
      `${head.kind} peer=${fp} ${method} ${head.path.split("?")[0]} -> ${status} (${Date.now() - startedAt}ms)`,
    );
  }
}

// Reads and validates the HEAD frame within the HEAD timeout; null when invalid.
async function readHead(reader: FrameReader): Promise<TunnelRequestHead | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const frame = await Promise.race([
      reader.next(MAX_HEAD_FRAME_BYTES),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("HEAD timeout")), HEAD_TIMEOUT_MS);
      }),
    ]);
    if (!frame) {
      return null;
    }
    const head = parseRequestHead(frame);
    // Origin-form paths only: no authority form and no control characters.
    return head.path.startsWith("//") || hasControlOrSpace(head.path) ? null : head;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// True when a path holds a space, DEL or an ASCII control character.
function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

// Counting semaphore for concurrent streams.
class Slots {
  private waiters: Array<() => void> = [];

  constructor(private free: number) {}

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    } else {
      this.free += 1;
    }
  }
}

function hexOf(peerKey: string): string {
  return peerKey.startsWith("iroh:") ? peerKey.slice("iroh:".length) : peerKey;
}

// First line of an error, without stack, for logs.
function short(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 160);
}

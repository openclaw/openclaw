import { randomUUID } from "node:crypto";
import type { PeerSession } from "./types.js";

type PendingRpc = {
  deviceId: string;
  method: string;
  resolve: (value: PeerRpcResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type PeerRpcResult = {
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string } | null;
};

export class PeerRegistry {
  private peersById = new Map<string, PeerSession>();
  private peersByConn = new Map<string, string>();
  private pendingRpc = new Map<string, PendingRpc>();

  register(session: PeerSession): void {
    // If a peer reconnects, close the old session first.
    const existing = this.peersById.get(session.deviceId);
    if (existing) {
      this.unregister(existing.connId);
    }
    this.peersById.set(session.deviceId, session);
    this.peersByConn.set(session.connId, session.deviceId);
  }

  unregister(connId: string): string | null {
    const deviceId = this.peersByConn.get(connId);
    if (!deviceId) {
      return null;
    }
    this.peersByConn.delete(connId);
    // Only remove from peersById if the connId matches (avoids race with reconnect).
    const session = this.peersById.get(deviceId);
    if (session && session.connId === connId) {
      this.peersById.delete(deviceId);
    }
    // Fail pending RPCs for this peer.
    for (const [id, pending] of this.pendingRpc.entries()) {
      if (pending.deviceId !== deviceId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        error: { code: "PEER_DISCONNECTED", message: `peer disconnected (${pending.method})` },
      });
      this.pendingRpc.delete(id);
    }
    return deviceId;
  }

  get(deviceId: string): PeerSession | undefined {
    return this.peersById.get(deviceId);
  }

  getByConnId(connId: string): PeerSession | undefined {
    const deviceId = this.peersByConn.get(connId);
    if (!deviceId) {
      return undefined;
    }
    return this.peersById.get(deviceId);
  }

  listConnected(): PeerSession[] {
    return [...this.peersById.values()];
  }

  /**
   * Invoke an RPC method on a connected peer via their WebSocket.
   * Returns a promise that resolves when the peer responds or times out.
   */
  async invoke(params: {
    deviceId: string;
    method: string;
    params?: unknown;
    timeoutMs?: number;
  }): Promise<PeerRpcResult> {
    const peer = this.peersById.get(params.deviceId);
    if (!peer) {
      return {
        ok: false,
        error: { code: "NOT_CONNECTED", message: "peer not connected" },
      };
    }
    const requestId = randomUUID();
    const frame = JSON.stringify({
      type: "req",
      id: requestId,
      method: params.method,
      params: params.params,
    });
    try {
      peer.socket.send(frame);
    } catch {
      return {
        ok: false,
        error: { code: "SEND_FAILED", message: "failed to send to peer" },
      };
    }
    const timeoutMs = params.timeoutMs ?? 30_000;
    return await new Promise<PeerRpcResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(requestId);
        resolve({
          ok: false,
          error: { code: "TIMEOUT", message: "peer RPC timed out" },
        });
      }, timeoutMs);
      this.pendingRpc.set(requestId, {
        deviceId: params.deviceId,
        method: params.method,
        resolve,
        timer,
      });
    });
  }

  /**
   * Handle an incoming RPC response from a peer.
   */
  handleRpcResult(params: {
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: { code?: string; message?: string } | null;
  }): boolean {
    const pending = this.pendingRpc.get(params.id);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingRpc.delete(params.id);
    pending.resolve({
      ok: params.ok,
      payload: params.payload,
      error: params.error ?? null,
    });
    return true;
  }

  /**
   * Broadcast an event to all connected peers.
   */
  broadcastEvent(event: string, payload?: unknown): void {
    const frame = JSON.stringify({ type: "event", event, payload });
    for (const peer of this.peersById.values()) {
      try {
        peer.socket.send(frame);
      } catch {
        // ignore send failures
      }
    }
  }

  /**
   * Send an event to a specific peer.
   */
  sendEvent(deviceId: string, event: string, payload?: unknown): boolean {
    const peer = this.peersById.get(deviceId);
    if (!peer) {
      return false;
    }
    try {
      peer.socket.send(JSON.stringify({ type: "event", event, payload }));
      return true;
    } catch {
      return false;
    }
  }
}

import { randomUUID } from "node:crypto";
import { WebSocket, type ClientOptions, type CertMeta } from "ws";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { normalizeFingerprint } from "../infra/tls/fingerprint.js";
import { rawDataToString } from "../infra/ws.js";
import { buildMeshConnectAuth, verifyMeshConnectAuth } from "./handshake.js";
import type { PeerRegistry } from "./peer-registry.js";
import type { MeshConnectResult, PeerSession } from "./types.js";

export type MeshPeerClientOptions = {
  /** Remote peer's WebSocket URL (e.g. "wss://jetson.local:18789"). */
  url: string;
  /** Remote peer's expected device ID. */
  remoteDeviceId: string;
  /** Local gateway's device identity. */
  identity: DeviceIdentity;
  /** Peer registry to register connection into. */
  peerRegistry: PeerRegistry;
  /** Optional TLS fingerprint for certificate pinning. */
  tlsFingerprint?: string;
  /** Local display name to send during handshake. */
  displayName?: string;
  /** Capabilities to advertise. */
  capabilities?: string[];
  /** Called when the peer connection is established. */
  onConnected?: (session: PeerSession) => void;
  /** Called when the peer disconnects. */
  onDisconnected?: (deviceId: string) => void;
  /** Called on errors. */
  onError?: (err: Error) => void;
};

export class MeshPeerClient {
  private ws: WebSocket | null = null;
  private opts: MeshPeerClientOptions;
  private backoffMs = 1000;
  private closed = false;
  private connId: string = randomUUID();

  constructor(opts: MeshPeerClientOptions) {
    this.opts = opts;
  }

  start() {
    if (this.closed) {
      return;
    }
    this.connId = randomUUID();
    const url = this.opts.url;

    const wsOptions: ClientOptions = {
      maxPayload: 10 * 1024 * 1024,
    };
    if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
      wsOptions.rejectUnauthorized = false;
      wsOptions.checkServerIdentity = ((_host: string, cert: CertMeta) => {
        const fingerprintValue =
          typeof cert === "object" && cert && "fingerprint256" in cert
            ? ((cert as { fingerprint256?: string }).fingerprint256 ?? "")
            : "";
        const fingerprint = normalizeFingerprint(
          typeof fingerprintValue === "string" ? fingerprintValue : "",
        );
        const expected = normalizeFingerprint(this.opts.tlsFingerprint ?? "");
        if (!expected) {
          return new Error("mesh tls fingerprint missing");
        }
        if (!fingerprint) {
          return new Error("mesh tls fingerprint unavailable");
        }
        if (fingerprint !== expected) {
          return new Error("mesh tls fingerprint mismatch");
        }
        return undefined;
        // oxlint-disable-next-line typescript/no-explicit-any
      }) as any;
    }

    this.ws = new WebSocket(url, wsOptions);

    this.ws.on("open", () => {
      this.sendMeshConnect();
    });
    this.ws.on("message", (data) => this.handleMessage(rawDataToString(data)));
    this.ws.on("close", (_code, reason) => {
      const _reasonText = rawDataToString(reason);
      const ws = this.ws;
      this.ws = null;
      if (ws) {
        this.opts.peerRegistry.unregister(this.connId);
        this.opts.onDisconnected?.(this.opts.remoteDeviceId);
      }
      this.scheduleReconnect();
    });
    this.ws.on("error", (err) => {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  stop() {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private sendMeshConnect() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const auth = buildMeshConnectAuth({
      identity: this.opts.identity,
      displayName: this.opts.displayName,
      capabilities: this.opts.capabilities,
    });
    const frame = JSON.stringify({
      type: "req",
      id: randomUUID(),
      method: "mesh.connect",
      params: { version: 1, ...auth },
    });
    this.ws.send(frame);
  }

  private handleMessage(raw: string) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === "res" && parsed.ok) {
        this.handleConnectResponse(parsed.payload as MeshConnectResult);
        return;
      }
      if (parsed.type === "res" && !parsed.ok) {
        this.opts.onError?.(new Error(parsed.error?.message ?? "mesh.connect rejected"));
        this.ws?.close(1008, "mesh.connect rejected");
        return;
      }
      // After connection is established, handle incoming RPC requests and responses.
      if (parsed.type === "req") {
        // Peer is invoking a method on us — not handled in the outbound client.
        // Forward to the server-side handler infrastructure if needed.
        return;
      }
      if (parsed.type === "res") {
        this.opts.peerRegistry.handleRpcResult({
          id: parsed.id,
          ok: parsed.ok,
          payload: parsed.payload,
          error: parsed.error,
        });
      }
    } catch {
      // ignore parse errors
    }
  }

  private handleConnectResponse(result: MeshConnectResult) {
    if (!result || !result.deviceId || !result.publicKey || !result.signature) {
      this.opts.onError?.(new Error("invalid mesh.connect response"));
      this.ws?.close(1008, "invalid response");
      return;
    }
    // Verify the server's identity matches what we expected.
    if (result.deviceId !== this.opts.remoteDeviceId) {
      this.opts.onError?.(new Error("mesh peer device ID mismatch"));
      this.ws?.close(1008, "device ID mismatch");
      return;
    }
    // Verify the server's signature (mutual auth).
    const valid = verifyMeshConnectAuth({
      deviceId: result.deviceId,
      publicKey: result.publicKey,
      signature: result.signature,
      signedAtMs: result.signedAtMs,
    });
    if (!valid) {
      this.opts.onError?.(new Error("mesh peer signature verification failed"));
      this.ws?.close(1008, "signature mismatch");
      return;
    }
    // Register the peer session.
    const session: PeerSession = {
      deviceId: result.deviceId,
      connId: this.connId,
      displayName: result.displayName,
      publicKey: result.publicKey,
      socket: this.ws!,
      outbound: true,
      capabilities: result.capabilities ?? [],
      connectedAtMs: Date.now(),
    };
    this.opts.peerRegistry.register(session);
    this.backoffMs = 1000;
    this.opts.onConnected?.(session);
  }

  private scheduleReconnect() {
    if (this.closed) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => this.start(), delay).unref();
  }
}

import type { WebSocket } from "ws";

export type PeerSession = {
  /** Remote peer's device ID (SHA256 of Ed25519 public key). */
  deviceId: string;
  /** WebSocket connection ID (unique per connection). */
  connId: string;
  /** Remote peer's display name. */
  displayName?: string;
  /** Remote peer's public key in PEM or base64url format. */
  publicKey?: string;
  /** The WebSocket instance for this peer connection. */
  socket: WebSocket;
  /** Whether this side initiated the connection (outbound). */
  outbound: boolean;
  /** Capabilities advertised by the remote peer. */
  capabilities: string[];
  /** Timestamp when this peer connected. */
  connectedAtMs: number;
};

export type MeshForwardPayload = {
  /** Channel to deliver the message to (e.g. "telegram", "whatsapp"). */
  channel: string;
  /** Recipient identifier on the target channel. */
  to: string;
  /** Text message content. */
  message?: string;
  /** Media URL to attach. */
  mediaUrl?: string;
  /** Multiple media URLs. */
  mediaUrls?: string[];
  /** Account ID on the target channel. */
  accountId?: string;
  /** The gateway that originated this forward (for loop prevention). */
  originGatewayId: string;
  /** Idempotency key to deduplicate. */
  idempotencyKey: string;
};

export type MeshCapabilities = {
  /** Channel IDs this gateway can deliver to. */
  channels: string[];
  /** Skill IDs available on this gateway. */
  skills: string[];
  /** Platform identifier (e.g. "darwin", "linux"). */
  platform: string;
};

export type MeshConnectParams = {
  /** Protocol version. */
  version: 1;
  /** Connecting peer's device ID. */
  deviceId: string;
  /** Connecting peer's public key (base64url of raw Ed25519). */
  publicKey: string;
  /** Signature of the auth payload. */
  signature: string;
  /** Timestamp when the signature was created (ms). */
  signedAtMs: number;
  /** Challenge nonce received from the server. */
  nonce?: string;
  /** Display name. */
  displayName?: string;
  /** Capabilities offered by this peer. */
  capabilities?: string[];
};

export type MeshConnectResult = {
  /** Accepted: the server's own device ID. */
  deviceId: string;
  /** Server's public key (base64url). */
  publicKey: string;
  /** Server's signature over the mutual auth payload. */
  signature: string;
  /** Server's signed-at timestamp. */
  signedAtMs: number;
  /** Server's display name. */
  displayName?: string;
  /** Server's capabilities. */
  capabilities?: string[];
};

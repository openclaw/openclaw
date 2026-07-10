import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { rawDataToString } from "../../infra/ws.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendRateLimited,
  sendUnauthorized,
} from "../http-common.js";
import { onGatewaySessionEnded } from "../session-end-events.js";
import { GuestConnectionRegistry, type GuestSocket } from "./connection-registry.js";
import { normalizeGuestDisplayName } from "./display-name.js";
import {
  GuestGrantStore,
  GuestGrantStoreError,
  type GuestConnectionTokenBinding,
  type GuestGrant,
} from "./grant-store.js";
import { GuestRedeemRateLimiter, type GuestRedeemRateLimitOptions } from "./rate-limit.js";
import { GUEST_RPC_ALLOWLIST } from "./rpc-policy.js";

export const GUEST_CONNECTION_TOKEN_TTL_MS = 7 * 60_000;
export const GUEST_WS_PATH = "/guest/ws";
export const GUEST_WS_SUBPROTOCOL = "openclaw.guest.v1";
const GUEST_REDEEM_PATH = "/guest/redeem";
const GUEST_HTTP_BODY_LIMIT_BYTES = 16 * 1024;
const GUEST_WS_MAX_PAYLOAD_BYTES = 64 * 1024;

export type GuestIdentity = { issuer: "deva"; subject: string };

export type GuestJoinSummary = {
  guestId: string;
  grantId: string;
  sessionKey: string;
  displayName: string;
};

export type GuestRedeemSuccess = {
  ok: true;
  join: GuestJoinSummary;
  connectionToken: string;
  connectionTokenExpiresAtMs: number;
};

export type GuestRedeemFailure = {
  ok: false;
  reason: "rate_limited" | "unauthorized" | "guest_limit" | "invalid_display_name";
  retryAfterMs?: number;
};

export type GuestRedeemResult = GuestRedeemSuccess | GuestRedeemFailure;

export type GuestLockoutEvent = {
  grantId: string;
  sessionKey: string;
  dimension: "ip" | "code";
  lockedUntilMs: number;
};

export type GuestAccessRaceHooks = {
  beforeRedeemCommit?: () => Promise<void>;
  beforeTokenConsume?: () => Promise<void>;
  beforeTokenRefresh?: () => Promise<void>;
};

export type GuestAccessControllerOptions = {
  store: GuestGrantStore;
  connections?: GuestConnectionRegistry;
  now?: () => number;
  tokenTtlMs?: number;
  rateLimit?: GuestRedeemRateLimitOptions;
  onLockout?: (event: GuestLockoutEvent) => void;
  verifyIdentityAssertion?: (assertion: string) => Promise<GuestIdentity | undefined>;
  hooks?: GuestAccessRaceHooks;
};

type GuestRefreshResult =
  | {
      ok: true;
      connectionToken: string;
      connectionTokenExpiresAtMs: number;
    }
  | { ok: false; reason: "unauthorized" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mintConnectionToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeRequestPath(rawUrl: string | undefined): URL | undefined {
  try {
    return new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

function writeUpgradeUnauthorized(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

function hasGuestSubprotocol(req: IncomingMessage): boolean {
  const value = req.headers["sec-websocket-protocol"];
  const protocols = (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((entry) => entry.trim());
  return protocols.includes(GUEST_WS_SUBPROTOCOL);
}

function authResponse(id: unknown) {
  return {
    type: "res" as const,
    id: typeof id === "string" ? id : "invalid",
    ok: false as const,
    error: errorShape(ErrorCodes.AUTH, "guest method not authorized"),
  };
}

export class GuestAccessController {
  readonly connections: GuestConnectionRegistry;
  private readonly store: GuestGrantStore;
  private readonly now: () => number;
  private readonly tokenTtlMs: number;
  private readonly rateLimiter: GuestRedeemRateLimiter;
  private readonly onLockout: ((event: GuestLockoutEvent) => void) | undefined;
  private readonly verifyIdentityAssertion: GuestAccessControllerOptions["verifyIdentityAssertion"];
  private readonly hooks: GuestAccessRaceHooks;
  private readonly guestWss: WebSocketServer;
  private readonly unsubscribeSessionEnd: () => void;
  private closed = false;

  get grantStore(): GuestGrantStore {
    return this.store;
  }

  constructor(options: GuestAccessControllerOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.tokenTtlMs = options.tokenTtlMs ?? GUEST_CONNECTION_TOKEN_TTL_MS;
    if (!Number.isInteger(this.tokenTtlMs) || this.tokenTtlMs <= 0) {
      throw new Error("tokenTtlMs must be a positive integer");
    }
    this.rateLimiter = new GuestRedeemRateLimiter(options.rateLimit);
    this.onLockout = options.onLockout;
    this.verifyIdentityAssertion = options.verifyIdentityAssertion;
    this.hooks = options.hooks ?? {};
    this.connections =
      options.connections ??
      new GuestConnectionRegistry({
        now: this.now,
        onExpired: (binding) => this.store.deleteJoin(binding.guestId),
      });
    // A process crash can strand hashes whose plaintext token was never returned or was
    // already consumed. Joins are transient; ordinals remain on their durable grants.
    this.store.purgeAllJoins();
    this.guestWss = new WebSocketServer({
      noServer: true,
      maxPayload: GUEST_WS_MAX_PAYLOAD_BYTES,
      handleProtocols: (protocols) =>
        protocols.has(GUEST_WS_SUBPROTOCOL) ? GUEST_WS_SUBPROTOCOL : false,
    });
    this.unsubscribeSessionEnd = onGatewaySessionEnded((event) => {
      if (event.reason !== "shutdown" && event.reason !== "restart") {
        this.endSession(event.sessionKey);
      }
    });
  }

  async redeem(params: {
    code: string;
    clientIp?: string;
    identity?: GuestIdentity;
    displayName?: string;
  }): Promise<GuestRedeemResult> {
    const code = typeof params.code === "string" ? params.code : "";
    const rateCheck = this.rateLimiter.check(params.clientIp, code);
    if (!rateCheck.allowed) {
      return { ok: false, reason: "rate_limited", retryAfterMs: rateCheck.retryAfterMs };
    }
    const grant = this.store.findRedeemableGrant(code);
    if (!grant || !this.identityMatches(grant, params.identity)) {
      this.recordRedeemFailure(params.clientIp, code, grant);
      return { ok: false, reason: "unauthorized" };
    }
    let displayName: string | undefined;
    try {
      displayName = normalizeGuestDisplayName(params.displayName);
    } catch {
      return { ok: false, reason: "invalid_display_name" };
    }
    await this.hooks.beforeRedeemCommit?.();
    const connectionToken = mintConnectionToken();
    const connectionTokenExpiresAtMs = Math.min(this.now() + this.tokenTtlMs, grant.expiresAtMs);
    try {
      const join = this.store.redeemGrant({
        code,
        token: connectionToken,
        tokenExpiresAtMs: connectionTokenExpiresAtMs,
        ...(params.identity ? { devaUserId: params.identity.subject } : {}),
        ...(displayName ? { displayName } : {}),
      });
      this.rateLimiter.resetIp(params.clientIp);
      return {
        ok: true,
        join: {
          guestId: join.guestId,
          grantId: grant.grantId,
          sessionKey: grant.sessionKey,
          displayName: join.displayName,
        },
        connectionToken,
        connectionTokenExpiresAtMs: join.tokenExpiresAtMs,
      };
    } catch (error) {
      if (error instanceof GuestGrantStoreError && error.code === "guest_limit") {
        return { ok: false, reason: "guest_limit" };
      }
      if (error instanceof GuestGrantStoreError) {
        return { ok: false, reason: "unauthorized" };
      }
      throw error;
    }
  }

  async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    context: { clientIp?: string },
  ): Promise<boolean> {
    const url = safeRequestPath(req.url);
    if (url?.pathname !== GUEST_REDEEM_PATH) {
      return false;
    }
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }
    const body = await readJsonBodyOrError(req, res, GUEST_HTTP_BODY_LIMIT_BYTES);
    if (body === undefined) {
      return true;
    }
    if (!isRecord(body) || typeof body.code !== "string") {
      sendInvalidRequest(res, "code is required");
      return true;
    }
    if (body.displayName !== undefined && typeof body.displayName !== "string") {
      sendInvalidRequest(res, "displayName must be a string");
      return true;
    }
    if (body.identityAssertion !== undefined && typeof body.identityAssertion !== "string") {
      sendInvalidRequest(res, "identityAssertion must be a string");
      return true;
    }
    const identity =
      typeof body.identityAssertion === "string"
        ? await this.verifyIdentityAssertion?.(body.identityAssertion)
        : undefined;
    const result = await this.redeem({
      code: body.code,
      ...(context.clientIp === undefined ? {} : { clientIp: context.clientIp }),
      ...(identity ? { identity } : {}),
      ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
    });
    if (result.ok) {
      sendJson(res, 200, result);
    } else if (result.reason === "rate_limited") {
      sendRateLimited(res, result.retryAfterMs);
    } else if (result.reason === "invalid_display_name") {
      sendInvalidRequest(res, "invalid displayName");
    } else if (result.reason === "guest_limit") {
      sendJson(res, 409, { error: { type: "guest_limit", message: "Guest limit reached" } });
    } else {
      sendUnauthorized(res);
    }
    return true;
  }

  async authenticateConnectionToken(
    token: string,
  ): Promise<GuestConnectionTokenBinding | undefined> {
    await this.hooks.beforeTokenConsume?.();
    return this.store.consumeConnectionToken({ token });
  }

  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const url = safeRequestPath(req.url);
    if (url?.pathname !== GUEST_WS_PATH) {
      return false;
    }
    const tokens = url.searchParams.getAll("guest_token");
    if (tokens.length !== 1 || !tokens[0] || !hasGuestSubprotocol(req)) {
      writeUpgradeUnauthorized(socket);
      return true;
    }
    const binding = await this.authenticateConnectionToken(tokens[0]);
    if (!binding) {
      writeUpgradeUnauthorized(socket);
      return true;
    }
    // Strip the one-use credential before the request reaches WebSocket callbacks or logs.
    req.url = GUEST_WS_PATH;
    try {
      this.guestWss.handleUpgrade(req, socket, head, (ws) => {
        this.attachSocket(binding, ws);
      });
    } catch {
      this.store.deleteJoin(binding.join.guestId);
      writeUpgradeUnauthorized(socket);
    }
    return true;
  }

  registerConnection(binding: GuestConnectionTokenBinding, socket: GuestSocket): void {
    this.connections.register(
      {
        guestId: binding.join.guestId,
        grantId: binding.grant.grantId,
        sessionKey: binding.grant.sessionKey,
        subscription: `session:${binding.grant.sessionKey}`,
        expiresAtMs: binding.join.tokenExpiresAtMs,
      },
      socket,
    );
  }

  async refreshGuest(guestId: string): Promise<GuestRefreshResult> {
    if (!this.connections.hasGuest(guestId)) {
      return { ok: false, reason: "unauthorized" };
    }
    await this.hooks.beforeTokenRefresh?.();
    const connectionToken = mintConnectionToken();
    const connectionTokenExpiresAtMs = this.now() + this.tokenTtlMs;
    const rotated = this.store.rotateConnectionToken({
      guestId,
      token: connectionToken,
      expiresAtMs: connectionTokenExpiresAtMs,
    });
    if (!rotated || !this.connections.refreshDeadline(guestId, rotated.tokenExpiresAtMs)) {
      return { ok: false, reason: "unauthorized" };
    }
    return {
      ok: true,
      connectionToken,
      connectionTokenExpiresAtMs: rotated.tokenExpiresAtMs,
    };
  }

  revokeGrant(grantId: string): GuestGrant | undefined {
    const revoked = this.store.revokeGrantAndPurgeJoins(grantId);
    this.connections.closeGrant(grantId, 4403, "guest grant revoked");
    return revoked;
  }

  kickGuest(guestId: string): boolean {
    const closed = this.connections.closeGuest(guestId, 4403, "guest access removed");
    this.store.deleteJoin(guestId);
    return closed;
  }

  endSession(sessionKey: string): number {
    const revoked = this.store.revokeSessionGrantsAndPurgeJoins(sessionKey);
    this.connections.closeSession(sessionKey, 4403, "host session ended");
    return revoked.length;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeSessionEnd();
    this.rateLimiter.close();
    this.connections.closeAll();
    this.store.close();
    try {
      this.guestWss.close();
    } catch {
      // noServer WebSocket servers can already be closed after all clients detach.
    }
  }

  private identityMatches(grant: GuestGrant, identity: GuestIdentity | undefined): boolean {
    if (grant.audience === "open") {
      return identity === undefined || identity.issuer === "deva";
    }
    return (
      identity?.issuer === grant.invitedPrincipal?.issuer &&
      identity?.subject === grant.invitedPrincipal.subject
    );
  }

  private recordRedeemFailure(
    clientIp: string | undefined,
    code: string,
    grant: GuestGrant | undefined,
  ): void {
    const lockouts = this.rateLimiter.recordFailure(clientIp, code);
    if (!grant || !this.onLockout) {
      return;
    }
    for (const lockout of lockouts) {
      this.onLockout({
        grantId: grant.grantId,
        sessionKey: grant.sessionKey,
        dimension: lockout.dimension,
        lockedUntilMs: this.now() + lockout.retryAfterMs,
      });
    }
  }

  private attachSocket(binding: GuestConnectionTokenBinding, socket: WebSocket): void {
    this.registerConnection(binding, socket);
    socket.on("message", (data) => {
      void this.handleGuestMessage(binding.join.guestId, socket, data);
    });
    socket.once("close", () => {
      if (this.connections.unregister(binding.join.guestId, socket)) {
        this.store.deleteConsumedJoin(binding.join.guestId);
      }
    });
  }

  private async handleGuestMessage(guestId: string, socket: WebSocket, data: RawData) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data)) as unknown;
    } catch {
      this.send(socket, authResponse("invalid"));
      return;
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        this.send(socket, authResponse("invalid"));
        return;
      }
      for (const entry of parsed) {
        this.send(socket, authResponse(isRecord(entry) ? entry.id : "invalid"));
      }
      return;
    }
    if (
      !isRecord(parsed) ||
      parsed.type !== "req" ||
      typeof parsed.id !== "string" ||
      typeof parsed.method !== "string" ||
      !GUEST_RPC_ALLOWLIST.has(parsed.method)
    ) {
      this.send(socket, authResponse(isRecord(parsed) ? parsed.id : "invalid"));
      return;
    }
    if (parsed.method !== "guest.token.refresh") {
      this.send(socket, authResponse(parsed.id));
      return;
    }
    const refreshed = await this.refreshGuest(guestId);
    if (!refreshed.ok) {
      this.send(socket, authResponse(parsed.id));
      return;
    }
    this.send(socket, { type: "res", id: parsed.id, ok: true, payload: refreshed });
  }

  private send(socket: WebSocket, frame: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }
}

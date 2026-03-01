import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import os from "node:os";
import type { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "../../auth.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import type { GatewayWsClient } from "../ws-types.js";
import { loadConfig } from "../../../config/config.js";
import {
  deriveDeviceIdFromPublicKey,
  normalizeDevicePublicKeyBase64Url,
  verifyDeviceSignature,
} from "../../../infra/device-identity.js";
import {
  approveDevicePairing,
  ensureDeviceToken,
  getPairedDevice,
  requestDevicePairing,
  updatePairedDeviceMetadata,
  verifyDeviceToken,
} from "../../../infra/device-pairing.js";
import { updatePairedNodeMetadata } from "../../../infra/node-pairing.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../../../infra/skills-remote.js";
import { upsertPresence } from "../../../infra/system-presence.js";
import { loadVoiceWakeConfig } from "../../../infra/voicewake.js";
import { rawDataToString } from "../../../infra/ws.js";
import { isGatewayCliClient, isWebchatClient } from "../../../utils/message-channel.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
} from "../../auth-rate-limit.js";
import { authorizeGatewayConnect, isLocalDirectRequest } from "../../auth.js";
import { buildDeviceAuthPayload, buildDeviceAuthPayloadV3 } from "../../device-auth.js";
import { isLoopbackAddress, isTrustedProxyAddress, resolveGatewayClientIp } from "../../net.js";
import { resolveHostName } from "../../net.js";
import { resolveNodeCommandAllowlist } from "../../node-command-policy.js";
import { checkBrowserOrigin } from "../../origin-check.js";
import { GATEWAY_CLIENT_IDS } from "../../protocol/client-info.js";
import {
  ConnectErrorDetailCodes,
  resolveAuthConnectErrorDetailCode,
  resolveDeviceAuthConnectErrorDetailCode,
} from "../../protocol/connect-error-details.js";
import {
  type ConnectParams,
  ErrorCodes,
  type ErrorShape,
  errorShape,
  formatValidationErrors,
  PROTOCOL_VERSION,
  validateConnectParams,
  validateRequestFrame,
} from "../../protocol/index.js";
import { MAX_BUFFERED_BYTES, MAX_PAYLOAD_BYTES, TICK_INTERVAL_MS } from "../../server-constants.js";
import { handleGatewayRequest } from "../../server-methods.js";
import { formatError } from "../../server-utils.js";
import { resolveTenantContext, validateTenantAccess } from "../../tenant-context.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import {
  buildGatewaySnapshot,
  getHealthCache,
  getHealthVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "../health-state.js";
import { formatGatewayAuthFailureMessage, type AuthProvidedKind } from "./auth-messages.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const DEVICE_SIGNATURE_SKEW_MS = 10 * 60 * 1000;

export function attachGatewayWsMessageHandler(params: {
  socket: WebSocket;
  upgradeReq: IncomingMessage;
  connId: string;
  remoteAddr?: string;
  forwardedFor?: string;
  realIp?: string;
  requestHost?: string;
  requestOrigin?: string;
  requestUserAgent?: string;
  canvasHostUrl?: string;
  connectNonce: string;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Browser-origin rate limiter (loopback is never exempt). */
  browserRateLimiter?: AuthRateLimiter;
  gatewayMethods: string[];
  events: string[];
  extraHandlers: GatewayRequestHandlers;
  buildRequestContext: () => GatewayRequestContext;
  send: (obj: unknown) => void;
  close: (code?: number, reason?: string) => void;
  isClosed: () => boolean;
  clearHandshakeTimer: () => void;
  getClient: () => GatewayWsClient | null;
  setClient: (next: GatewayWsClient) => void;
  setHandshakeState: (state: "pending" | "connected" | "failed") => void;
  setCloseCause: (cause: string, meta?: Record<string, unknown>) => void;
  setLastFrameMeta: (meta: { type?: string; method?: string; id?: string }) => void;
  logGateway: SubsystemLogger;
  logHealth: SubsystemLogger;
  logWsControl: SubsystemLogger;
}) {
  const {
    socket,
    upgradeReq,
    connId,
    remoteAddr,
    forwardedFor,
    realIp,
    requestHost,
    requestOrigin,
    requestUserAgent,
    canvasHostUrl,
    connectNonce,
    resolvedAuth,
    rateLimiter,
    browserRateLimiter,
    gatewayMethods,
    events,
    extraHandlers,
    buildRequestContext,
    send,
    close,
    isClosed,
    clearHandshakeTimer,
    getClient,
    setClient,
    setHandshakeState,
    setCloseCause,
    setLastFrameMeta,
    logGateway,
    logHealth,
    logWsControl,
  } = params;

  const configSnapshot = loadConfig();
  const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
  const clientIp = resolveGatewayClientIp({ remoteAddr, forwardedFor, realIp, trustedProxies });

  // If proxy headers are present but the remote address isn't trusted, don't treat
  // the connection as local. This prevents auth bypass when running behind a reverse
  // proxy without proper configuration - the proxy's loopback connection would otherwise
  // cause all external requests to be treated as trusted local clients.
  const hasProxyHeaders = Boolean(forwardedFor || realIp);
  const remoteIsTrustedProxy = isTrustedProxyAddress(remoteAddr, trustedProxies);
  const hasUntrustedProxyHeaders = hasProxyHeaders && !remoteIsTrustedProxy;
  const hostName = resolveHostName(requestHost);
  const hostIsLocal = hostName === "localhost" || hostName === "127.0.0.1" || hostName === "::1";
  const hostIsTailscaleServe = hostName.endsWith(".ts.net");
  const hostIsLocalish = hostIsLocal || hostIsTailscaleServe;
  const isLocalClient = isLocalDirectRequest(upgradeReq, trustedProxies);
  const reportedClientIp =
    isLocalClient || hasUntrustedProxyHeaders
      ? undefined
      : clientIp && !isLoopbackAddress(clientIp)
        ? clientIp
        : undefined;

  if (hasUntrustedProxyHeaders) {
    logWsControl.warn(
      "Proxy headers detected from untrusted address. " +
        "Connection will not be treated as local. " +
        "Configure gateway.trustedProxies to restore local client detection behind your proxy.",
    );
  }
  if (!hostIsLocalish && isLoopbackAddress(remoteAddr) && !hasProxyHeaders) {
    logWsControl.warn(
      "Loopback connection with non-local Host header. " +
        "Treating it as remote. If you're behind a reverse proxy, " +
        "set gateway.trustedProxies and forward X-Forwarded-For/X-Real-IP.",
    );
  }

  const isWebchatConnect = (p: ConnectParams | null | undefined) => isWebchatClient(p?.client);

  socket.on("message", async (data) => {
    if (isClosed()) {
      return;
    }
    const text = rawDataToString(data);
    try {
      const parsed = JSON.parse(text);
      const frameType =
        parsed && typeof parsed === "object" && "type" in parsed
          ? typeof (parsed as { type?: unknown }).type === "string"
            ? String((parsed as { type?: unknown }).type)
            : undefined
          : undefined;
      const frameMethod =
        parsed && typeof parsed === "object" && "method" in parsed
          ? typeof (parsed as { method?: unknown }).method === "string"
            ? String((parsed as { method?: unknown }).method)
            : undefined
          : undefined;
      const frameId =
        parsed && typeof parsed === "object" && "id" in parsed
          ? typeof (parsed as { id?: unknown }).id === "string"
            ? String((parsed as { id?: unknown }).id)
            : undefined
          : undefined;
      if (frameType || frameMethod || frameId) {
        setLastFrameMeta({ type: frameType, method: frameMethod, id: frameId });
      }

      const client = getClient();
      if (!client) {
        // Handshake must be a normal request:
        // { type:"req", method:"connect", params: ConnectParams }.
        const isRequestFrame = validateRequestFrame(parsed);
        if (
          !isRequestFrame ||
          parsed.method !== "connect" ||
          !validateConnectParams(parsed.params)
        ) {
          const handshakeError = isRequestFrame
            ? parsed.method === "connect"
              ? `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}`
              : "invalid handshake: first request must be connect"
            : "invalid request frame";
          setHandshakeState("failed");
          setCloseCause("invalid-handshake", {
            frameType,
            frameMethod,
            frameId,
            handshakeError,
          });
          if (isRequestFrame) {
            const req = parsed;
            send({
              type: "res",
              id: req.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, handshakeError),
            });
          } else {
            logWsControl.warn(
              `invalid handshake conn=${connId} remote=${remoteAddr ?? "?"} fwd=${forwardedFor ?? "n/a"} origin=${requestOrigin ?? "n/a"} host=${requestHost ?? "n/a"} ua=${requestUserAgent ?? "n/a"}`,
            );
          }
          const closeReason = truncateCloseReason(handshakeError || "invalid handshake");
          if (isRequestFrame) {
            queueMicrotask(() => close(1008, closeReason));
          } else {
            close(1008, closeReason);
          }
          return;
        }

        const frame = parsed;
        const connectParams = frame.params as ConnectParams;
        const clientLabel = connectParams.client.displayName ?? connectParams.client.id;

        // protocol negotiation
        const { minProtocol, maxProtocol } = connectParams;
        if (maxProtocol < PROTOCOL_VERSION || minProtocol > PROTOCOL_VERSION) {
          setHandshakeState("failed");
          logWsControl.warn(
            `protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`,
          );
          setCloseCause("protocol-mismatch", {
            minProtocol,
            maxProtocol,
            expectedProtocol: PROTOCOL_VERSION,
            client: connectParams.client.id,
            clientDisplayName: connectParams.client.displayName,
            mode: connectParams.client.mode,
            version: connectParams.client.version,
          });
          send({
            type: "res",
            id: frame.id,
            ok: false,
            error: errorShape(ErrorCodes.INVALID_REQUEST, "protocol mismatch", {
              details: { expectedProtocol: PROTOCOL_VERSION },
            }),
          });
          close(1002, "protocol mismatch");
          return;
        }

        const roleRaw = connectParams.role ?? "operator";
        const role = roleRaw === "operator" || roleRaw === "node" ? roleRaw : null;
        if (!role) {
          setHandshakeState("failed");
          setCloseCause("invalid-role", {
            role: roleRaw,
            client: connectParams.client.id,
            clientDisplayName: connectParams.client.displayName,
            mode: connectParams.client.mode,
            version: connectParams.client.version,
          });
          send({
            type: "res",
            id: frame.id,
            ok: false,
            error: errorShape(ErrorCodes.INVALID_REQUEST, "invalid role"),
          });
          close(1008, "invalid role");
          return;
        }
        // Default-deny: scopes must be explicit. Empty/missing scopes means no permissions.
        // Note: If the client does not present a device identity, we can't bind scopes to a paired
        // device/token, so we will clear scopes after auth to avoid self-declared permissions.
        let scopes = Array.isArray(connectParams.scopes) ? connectParams.scopes : [];
        connectParams.role = role;
        connectParams.scopes = scopes;

        const isControlUi = connectParams.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI;
        const isWebchat = isWebchatConnect(connectParams);
        // Reject non-local browser origins for all browser-origin clients (not just
        // control-ui/webchat) to prevent cross-origin WebSocket attacks.
        const hasBrowserOrigin = Boolean(requestOrigin);
        if (isControlUi || isWebchat || hasBrowserOrigin) {
          const originCheck = checkBrowserOrigin({
            requestHost,
            origin: requestOrigin,
            allowedOrigins: configSnapshot.gateway?.controlUi?.allowedOrigins,
            allowHostHeaderOriginFallback: true,
          });
          if (!originCheck.ok) {
            const errorMessage =
              "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
            setHandshakeState("failed");
            setCloseCause("origin-mismatch", {
              origin: requestOrigin ?? "n/a",
              host: requestHost ?? "n/a",
              reason: originCheck.reason,
              client: connectParams.client.id,
              clientDisplayName: connectParams.client.displayName,
              mode: connectParams.client.mode,
              version: connectParams.client.version,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, errorMessage),
            });
            close(1008, truncateCloseReason(errorMessage));
            return;
          }
        }

        const deviceRaw = connectParams.device;
        let devicePublicKey: string | null = null;
        const hasTokenAuth = Boolean(connectParams.auth?.token);
        const hasPasswordAuth = Boolean(connectParams.auth?.password);
        const hasSharedAuth = hasTokenAuth || hasPasswordAuth;
        const allowInsecureControlUi =
          isControlUi && configSnapshot.gateway?.controlUi?.allowInsecureAuth === true;
        const allowControlUiBypass = allowInsecureControlUi;
        const device = deviceRaw;

        const hasDeviceTokenCandidate = Boolean(
          (connectParams.auth?.token || connectParams.auth?.deviceToken) && device,
        );
        // Browser-origin connections use the non-loopback-exempt rate limiter to prevent
        // brute-force attacks from browser-injected WebSocket connections on localhost.
        const effectiveRateLimiter =
          hasBrowserOrigin && browserRateLimiter ? browserRateLimiter : rateLimiter;
        let authResult: GatewayAuthResult = await authorizeGatewayConnect({
          auth: resolvedAuth,
          connectAuth: connectParams.auth,
          req: upgradeReq,
          trustedProxies,
          rateLimiter: hasDeviceTokenCandidate ? undefined : effectiveRateLimiter,
          clientIp,
          rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
        });

        if (
          hasDeviceTokenCandidate &&
          authResult.ok &&
          effectiveRateLimiter &&
          (authResult.method === "token" || authResult.method === "password")
        ) {
          const sharedRateCheck = effectiveRateLimiter.check(
            clientIp,
            AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
          );
          if (!sharedRateCheck.allowed) {
            authResult = {
              ok: false,
              reason: "rate_limited",
              rateLimited: true,
              retryAfterMs: sharedRateCheck.retryAfterMs,
            };
          } else {
            effectiveRateLimiter.reset(clientIp, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
          }
        }

        let authOk = authResult.ok;
        let authMethod =
          authResult.method ?? (resolvedAuth.mode === "password" ? "password" : "token");
        const sharedAuthResult = hasSharedAuth
          ? await authorizeGatewayConnect({
              auth: { ...resolvedAuth, allowTailscale: false },
              connectAuth: connectParams.auth,
              req: upgradeReq,
              trustedProxies,
              // Shared-auth probe only; rate-limit side effects are handled in
              // the primary auth flow (or deferred for device-token candidates).
              rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
            })
          : null;
        const sharedAuthOk =
          sharedAuthResult?.ok === true &&
          (sharedAuthResult.method === "token" || sharedAuthResult.method === "password");
        const rejectUnauthorized = (failedAuth: GatewayAuthResult) => {
          setHandshakeState("failed");
          logWsControl.warn(
            `unauthorized conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version} reason=${failedAuth.reason ?? "unknown"}`,
          );
          const authProvided: AuthProvidedKind = connectParams.auth?.token
            ? "token"
            : connectParams.auth?.password
              ? "password"
              : "none";
          const authMessage = formatGatewayAuthFailureMessage({
            authMode: resolvedAuth.mode,
            authProvided,
            reason: failedAuth.reason,
            client: connectParams.client,
          });
          setCloseCause("unauthorized", {
            authMode: resolvedAuth.mode,
            authProvided,
            authReason: failedAuth.reason,
            allowTailscale: resolvedAuth.allowTailscale,
            client: connectParams.client.id,
            clientDisplayName: connectParams.client.displayName,
            mode: connectParams.client.mode,
            version: connectParams.client.version,
          });
          send({
            type: "res",
            id: frame.id,
            ok: false,
            error: errorShape(ErrorCodes.INVALID_REQUEST, authMessage, {
              details: { code: resolveAuthConnectErrorDetailCode(failedAuth.reason) },
            }),
          });
          close(1008, truncateCloseReason(authMessage));
        };
        if (!device) {
          // IAM auth is cryptographically verified via JWKS — treat IAM-authenticated
          // control UI connections as trusted (equivalent to shared-secret for bypass purposes).
          const iamAuthOk = authOk && authMethod === "iam" && isControlUi;
          // Trusted-proxy auth verifies identity via the reverse proxy headers.
          const trustedProxyAuthOk =
            authOk && authMethod === "trusted-proxy" && resolvedAuth.mode === "trusted-proxy";
          // dangerouslyDisableDeviceAuth skips all device identity requirements.
          const dangerouslyDisableDeviceAuth =
            isControlUi && configSnapshot.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true;

          // Preserve scopes when the connection is authenticated via a trusted
          // method (shared secret, trusted proxy, IAM, or bypass mode).
          if (
            scopes.length > 0 &&
            !allowControlUiBypass &&
            !iamAuthOk &&
            !sharedAuthOk &&
            !trustedProxyAuthOk &&
            !dangerouslyDisableDeviceAuth
          ) {
            scopes = [];
            connectParams.scopes = scopes;
          }

          // Control UI requires an explicit bypass to connect without device identity.
          // Shared token alone is NOT sufficient — the UI needs one of:
          //   - allowInsecureAuth (+ localhost), OR
          //   - dangerouslyDisableDeviceAuth, OR
          //   - IAM auth, OR
          //   - trusted-proxy auth
          // Node role control-UI always requires device identity, no exceptions.
          if (
            isControlUi &&
            !allowControlUiBypass &&
            !iamAuthOk &&
            !trustedProxyAuthOk &&
            !dangerouslyDisableDeviceAuth
          ) {
            const errorMessage =
              role === "node"
                ? "control ui requires device identity"
                : "control ui requires HTTPS or localhost (secure context)";
            setHandshakeState("failed");
            setCloseCause(role === "node" ? "device-required" : "control-ui-insecure-auth", {
              client: connectParams.client.id,
              clientDisplayName: connectParams.client.displayName,
              mode: connectParams.client.mode,
              version: connectParams.client.version,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, errorMessage, {
                details: {
                  code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
                },
              }),
            });
            close(1008, errorMessage);
            return;
          }
          // Node role control-UI with trusted-proxy/IAM auth but no device:
          // still requires a device identity.
          if (isControlUi && role === "node") {
            const errorMessage = "control ui requires device identity";
            setHandshakeState("failed");
            setCloseCause("device-required", {
              client: connectParams.client.id,
              clientDisplayName: connectParams.client.displayName,
              mode: connectParams.client.mode,
              version: connectParams.client.version,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, errorMessage, {
                details: {
                  code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
                },
              }),
            });
            close(1008, errorMessage);
            return;
          }
          // Node role always requires a device identity regardless of auth method.
          // Only operators may connect without a device.
          const canSkipDevice =
            role !== "node" &&
            (sharedAuthOk ||
              (authOk && allowControlUiBypass) ||
              iamAuthOk ||
              trustedProxyAuthOk ||
              dangerouslyDisableDeviceAuth);

          // Allow shared-secret, IAM, trusted-proxy, or bypass connections to skip device identity.
          if (!canSkipDevice) {
            // Operators with verified shared-secret can proceed without a device identity.
            if (role === "operator" && sharedAuthOk) {
              // Allowed — sharedAuthOk is already part of canSkipDevice, but this
              // guard catches edge cases where canSkipDevice somehow evaluates false.
            } else if (!authOk && hasSharedAuth) {
              rejectUnauthorized(authResult);
              return;
            } else {
              setHandshakeState("failed");
              setCloseCause("device-required", {
                client: connectParams.client.id,
                clientDisplayName: connectParams.client.displayName,
                mode: connectParams.client.mode,
                version: connectParams.client.version,
              });
              send({
                type: "res",
                id: frame.id,
                ok: false,
                error: errorShape(ErrorCodes.NOT_PAIRED, "device identity required"),
              });
              close(1008, "device identity required");
              return;
            }
          }
        }
        if (device) {
          // When dangerouslyDisableDeviceAuth is enabled for control-UI connections,
          // skip all device signature / timestamp / nonce verification so stale or
          // malformed device identities are still accepted.
          const skipDeviceVerification =
            isControlUi && configSnapshot.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true;

          const derivedId = deriveDeviceIdFromPublicKey(device.publicKey);
          if (!skipDeviceVerification && (!derivedId || derivedId !== device.id)) {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              reason: "device-id-mismatch",
              client: connectParams.client.id,
              deviceId: device.id,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "device identity mismatch", {
                details: {
                  code: resolveDeviceAuthConnectErrorDetailCode("device-id-mismatch"),
                  reason: "device-id-mismatch",
                },
              }),
            });
            close(1008, "device identity mismatch");
            return;
          }
          if (!skipDeviceVerification) {
            const signedAt = device.signedAt;
            if (
              typeof signedAt !== "number" ||
              Math.abs(Date.now() - signedAt) > DEVICE_SIGNATURE_SKEW_MS
            ) {
              setHandshakeState("failed");
              setCloseCause("device-auth-invalid", {
                reason: "device-signature-stale",
                client: connectParams.client.id,
                deviceId: device.id,
              });
              send({
                type: "res",
                id: frame.id,
                ok: false,
                error: errorShape(ErrorCodes.INVALID_REQUEST, "device signature expired", {
                  details: {
                    code: resolveDeviceAuthConnectErrorDetailCode("device-signature-stale"),
                    reason: "device-signature-stale",
                  },
                }),
              });
              close(1008, "device signature expired");
              return;
            }
            const nonceRequired = !isLocalClient;
            const providedNonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
            if (nonceRequired && !providedNonce) {
              setHandshakeState("failed");
              setCloseCause("device-auth-invalid", {
                reason: "device-nonce-missing",
                client: connectParams.client.id,
                deviceId: device.id,
              });
              send({
                type: "res",
                id: frame.id,
                ok: false,
                error: errorShape(ErrorCodes.INVALID_REQUEST, "device nonce required", {
                  details: {
                    code: resolveDeviceAuthConnectErrorDetailCode("device-nonce-missing"),
                    reason: "device-nonce-missing",
                  },
                }),
              });
              close(1008, "device nonce required");
              return;
            }
            if (providedNonce && providedNonce !== connectNonce) {
              setHandshakeState("failed");
              setCloseCause("device-auth-invalid", {
                reason: "device-nonce-mismatch",
                client: connectParams.client.id,
                deviceId: device.id,
              });
              send({
                type: "res",
                id: frame.id,
                ok: false,
                error: errorShape(ErrorCodes.INVALID_REQUEST, "device nonce mismatch", {
                  details: {
                    code: resolveDeviceAuthConnectErrorDetailCode("device-nonce-mismatch"),
                    reason: "device-nonce-mismatch",
                  },
                }),
              });
              close(1008, "device nonce mismatch");
              return;
            }
            // Build the payload the node client signed.  Modern clients use v3
            // (includes platform/deviceFamily), older clients use v2.  Try v3
            // first, then fall back to v2.
            const basePayloadParams = {
              deviceId: device.id,
              clientId: connectParams.client.id,
              clientMode: connectParams.client.mode,
              role,
              scopes,
              signedAtMs: signedAt,
              token: connectParams.auth?.token ?? null,
              nonce: providedNonce || "",
            };
            const v3Payload = buildDeviceAuthPayloadV3({
              ...basePayloadParams,
              platform: connectParams.client.platform,
              deviceFamily: connectParams.client.deviceFamily,
            });
            const v2Payload = buildDeviceAuthPayload(basePayloadParams);
            const rejectDeviceSignatureInvalid = () => {
              setHandshakeState("failed");
              setCloseCause("device-auth-invalid", {
                reason: "device-signature",
                client: connectParams.client.id,
                deviceId: device.id,
              });
              send({
                type: "res",
                id: frame.id,
                ok: false,
                error: errorShape(ErrorCodes.INVALID_REQUEST, "device signature invalid", {
                  details: {
                    code: resolveDeviceAuthConnectErrorDetailCode("device-signature"),
                    reason: "device-signature",
                  },
                }),
              });
              close(1008, "device signature invalid");
            };
            const signatureOk =
              verifyDeviceSignature(device.publicKey, v3Payload, device.signature) ||
              verifyDeviceSignature(device.publicKey, v2Payload, device.signature);
            if (!signatureOk) {
              rejectDeviceSignatureInvalid();
              return;
            }
          }
          devicePublicKey = normalizeDevicePublicKeyBase64Url(device.publicKey);
          if (!devicePublicKey) {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              reason: "device-public-key",
              client: connectParams.client.id,
              deviceId: device.id,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "device public key invalid"),
            });
            close(1008, "device public key invalid");
            return;
          }
        }

        // Attempt device-token verification when shared-token auth failed.
        // Accept either auth.deviceToken (dedicated field) or auth.token as the
        // device token candidate so clients have flexibility in how they present it.
        const deviceTokenCandidate = connectParams.auth?.deviceToken || connectParams.auth?.token;
        // Track whether the client explicitly used the dedicated deviceToken field.
        const usedExplicitDeviceToken = Boolean(connectParams.auth?.deviceToken);
        if (!authOk && deviceTokenCandidate && device) {
          // Save the original shared-auth failure so we can restore it when
          // the fallback device-token check also fails and the client did not
          // use the explicit deviceToken field (they likely intended shared auth).
          const sharedAuthFailResult = authResult;
          if (effectiveRateLimiter) {
            const deviceRateCheck = effectiveRateLimiter.check(
              clientIp,
              AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
            );
            if (!deviceRateCheck.allowed) {
              authResult = {
                ok: false,
                reason: "rate_limited",
                rateLimited: true,
                retryAfterMs: deviceRateCheck.retryAfterMs,
              };
            }
          }
          if (!authResult.rateLimited) {
            const tokenCheck = await verifyDeviceToken({
              deviceId: device.id,
              token: deviceTokenCandidate,
              role,
              scopes,
            });
            if (tokenCheck.ok) {
              authOk = true;
              authMethod = "device-token";
              effectiveRateLimiter?.reset(clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
            } else {
              // When the client used auth.token (not auth.deviceToken) and the
              // shared-token check also failed, preserve the shared-token error
              // so the client sees the relevant "token mismatch" message.
              authResult = usedExplicitDeviceToken
                ? { ok: false, reason: "device_token_mismatch" }
                : sharedAuthFailResult;
              effectiveRateLimiter?.recordFailure(clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
            }
          }
        }
        if (!authOk) {
          rejectUnauthorized(authResult);
          return;
        }

        // Skip pairing only for dangerouslyDisableDeviceAuth (explicit bypass) or
        // IAM-authenticated control UI.  allowInsecureAuth alone does NOT bypass
        // pairing — it only relaxes the "device identity required" gate above.
        const dangerouslyDisableDeviceAuthForPairing =
          isControlUi && configSnapshot.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true;
        const skipPairing =
          (dangerouslyDisableDeviceAuthForPairing && sharedAuthOk) ||
          (isControlUi && authOk && authMethod === "iam");
        if (device && devicePublicKey && !skipPairing) {
          const requirePairing = async (reason: string, _paired?: { deviceId: string }) => {
            const pairing = await requestDevicePairing({
              deviceId: device.id,
              publicKey: devicePublicKey,
              displayName: connectParams.client.displayName,
              platform: connectParams.client.platform,
              clientId: connectParams.client.id,
              clientMode: connectParams.client.mode,
              role,
              scopes,
              remoteIp: reportedClientIp,
              // Browser-origin non-control-ui clients must not get silent auto-pairing,
              // even on loopback, to prevent malicious scripts from silently pairing.
              // Token auth auto-approves for: local connections, or cloud-provisioned
              // nodes (cap "cloud") whose only auth is the shared gateway token.
              silent:
                hasBrowserOrigin && !isControlUi
                  ? false
                  : isLocalClient ||
                    authMethod === "iam" ||
                    (authMethod === "token" &&
                      Array.isArray(connectParams.caps) &&
                      connectParams.caps.includes("cloud")),
            });
            const context = buildRequestContext();
            if (pairing.request.silent === true) {
              const approved = await approveDevicePairing(pairing.request.requestId);
              if (approved) {
                logGateway.info(
                  `device pairing auto-approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
                );
                context.broadcast(
                  "device.pair.resolved",
                  {
                    requestId: pairing.request.requestId,
                    deviceId: approved.device.deviceId,
                    decision: "approved",
                    ts: Date.now(),
                  },
                  { dropIfSlow: true },
                );
              }
            } else if (pairing.created) {
              context.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
            }
            if (pairing.request.silent !== true) {
              setHandshakeState("failed");
              setCloseCause("pairing-required", {
                deviceId: device.id,
                requestId: pairing.request.requestId,
                reason,
              });
              send({
                type: "res",
                id: frame.id,
                ok: false,
                error: errorShape(ErrorCodes.NOT_PAIRED, "pairing required", {
                  details: {
                    code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
                    requestId: pairing.request.requestId,
                  },
                }),
              });
              close(1008, "pairing required");
              return false;
            }
            return true;
          };

          const paired = await getPairedDevice(device.id);
          const isPaired = paired?.publicKey === devicePublicKey;
          if (!isPaired) {
            const ok = await requirePairing("not-paired");
            if (!ok) {
              return;
            }
          } else {
            const allowedRoles = new Set(
              Array.isArray(paired.roles) ? paired.roles : paired.role ? [paired.role] : [],
            );
            if (allowedRoles.size === 0) {
              const ok = await requirePairing("role-upgrade", paired);
              if (!ok) {
                return;
              }
            } else if (!allowedRoles.has(role)) {
              const ok = await requirePairing("role-upgrade", paired);
              if (!ok) {
                return;
              }
            }

            const pairedScopes = Array.isArray(paired.scopes) ? paired.scopes : [];
            if (scopes.length > 0) {
              if (pairedScopes.length === 0) {
                const ok = await requirePairing("scope-upgrade", paired);
                if (!ok) {
                  return;
                }
              } else {
                const allowedScopes = new Set(pairedScopes);
                const missingScope = scopes.find((scope) => !allowedScopes.has(scope));
                if (missingScope) {
                  const ok = await requirePairing("scope-upgrade", paired);
                  if (!ok) {
                    return;
                  }
                }
              }
            }

            await updatePairedDeviceMetadata(device.id, {
              displayName: connectParams.client.displayName,
              platform: connectParams.client.platform,
              clientId: connectParams.client.id,
              clientMode: connectParams.client.mode,
              role,
              scopes,
              remoteIp: reportedClientIp,
            });
          }
        }

        // Skip device-token issuance when device auth is bypassed — the token
        // would be meaningless because the device identity wasn't verified.
        const skipDeviceTokenIssuance =
          isControlUi && configSnapshot.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true;
        const deviceToken =
          device && !skipDeviceTokenIssuance
            ? await ensureDeviceToken({ deviceId: device.id, role, scopes })
            : null;

        if (role === "node") {
          const cfg = loadConfig();
          const allowlist = resolveNodeCommandAllowlist(cfg, {
            platform: connectParams.client.platform,
            deviceFamily: connectParams.client.deviceFamily,
          });
          const declared = Array.isArray(connectParams.commands) ? connectParams.commands : [];
          const filtered = declared
            .map((cmd) => cmd.trim())
            .filter((cmd) => cmd.length > 0 && allowlist.has(cmd));
          connectParams.commands = filtered;
        }

        const shouldTrackPresence = !isGatewayCliClient(connectParams.client);
        const clientId = connectParams.client.id;
        const instanceId = connectParams.client.instanceId;
        const presenceKey = shouldTrackPresence ? (device?.id ?? instanceId ?? connId) : undefined;

        logWs("in", "connect", {
          connId,
          client: connectParams.client.id,
          clientDisplayName: connectParams.client.displayName,
          version: connectParams.client.version,
          mode: connectParams.client.mode,
          clientId,
          platform: connectParams.client.platform,
          auth: authMethod,
        });

        if (isWebchatConnect(connectParams)) {
          logWsControl.info(
            `webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`,
          );
        }

        if (presenceKey) {
          upsertPresence(presenceKey, {
            host: connectParams.client.displayName ?? connectParams.client.id ?? os.hostname(),
            ip: isLocalClient ? undefined : reportedClientIp,
            version: connectParams.client.version,
            platform: connectParams.client.platform,
            deviceFamily: connectParams.client.deviceFamily,
            modelIdentifier: connectParams.client.modelIdentifier,
            mode: connectParams.client.mode,
            deviceId: device?.id,
            roles: [role],
            scopes,
            instanceId: device?.id ?? instanceId,
            reason: "connect",
          });
          incrementPresenceVersion();
        }

        const snapshot = buildGatewaySnapshot();
        const cachedHealth = getHealthCache();
        if (cachedHealth) {
          snapshot.health = cachedHealth;
          snapshot.stateVersion.health = getHealthVersion();
        }
        const helloOk = {
          type: "hello-ok",
          protocol: PROTOCOL_VERSION,
          server: {
            version:
              (process.env.BOT_VERSION?.trim() || undefined) ??
              (process.env.BOT_SERVICE_VERSION?.trim() || undefined) ??
              (process.env.npm_package_version?.trim() || undefined) ??
              "dev",
            commit: process.env.GIT_COMMIT,
            host: os.hostname(),
            connId,
          },
          features: { methods: gatewayMethods, events },
          snapshot,
          canvasHostUrl,
          auth: deviceToken
            ? {
                deviceToken: deviceToken.token,
                role: deviceToken.role,
                scopes: deviceToken.scopes,
                issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs,
              }
            : undefined,
          policy: {
            maxPayload: MAX_PAYLOAD_BYTES,
            maxBufferedBytes: MAX_BUFFERED_BYTES,
            tickIntervalMs: TICK_INTERVAL_MS,
          },
        };

        clearHandshakeTimer();
        const nextClient: GatewayWsClient = {
          socket,
          connect: connectParams,
          connId,
          presenceKey,
          clientIp: reportedClientIp,
        };

        // Enrich client with IAM tenant context when auth mode is "iam"
        if (authResult.iamResult && authResult.iamResult.ok) {
          nextClient.iamResult = authResult.iamResult;
          const tenant = resolveTenantContext({
            iamResult: authResult.iamResult,
            requestedTenant: connectParams.tenant,
          });
          if (tenant) {
            const accessError = validateTenantAccess({
              iamResult: authResult.iamResult,
              tenant,
            });
            if (accessError) {
              setHandshakeState("failed");
              send(errorShape(ErrorCodes.INVALID_REQUEST, `Tenant access denied: ${accessError}`));
              close(4003, accessError);
              return;
            }
            nextClient.tenant = tenant;
          }
        }

        setClient(nextClient);
        setHandshakeState("connected");
        if (role === "node") {
          const context = buildRequestContext();
          const nodeSession = context.nodeRegistry.register(nextClient, {
            remoteIp: reportedClientIp,
          });
          const instanceIdRaw = connectParams.client.instanceId;
          const instanceId = typeof instanceIdRaw === "string" ? instanceIdRaw.trim() : "";
          const nodeIdsForPairing = new Set<string>([nodeSession.nodeId]);
          if (instanceId) {
            nodeIdsForPairing.add(instanceId);
          }
          for (const nodeId of nodeIdsForPairing) {
            void updatePairedNodeMetadata(nodeId, {
              lastConnectedAtMs: nodeSession.connectedAtMs,
            }).catch((err) =>
              logGateway.warn(`failed to record last connect for ${nodeId}: ${formatForLog(err)}`),
            );
          }
          recordRemoteNodeInfo({
            nodeId: nodeSession.nodeId,
            displayName: nodeSession.displayName,
            platform: nodeSession.platform,
            deviceFamily: nodeSession.deviceFamily,
            commands: nodeSession.commands,
            remoteIp: nodeSession.remoteIp,
          });
          void refreshRemoteNodeBins({
            nodeId: nodeSession.nodeId,
            platform: nodeSession.platform,
            deviceFamily: nodeSession.deviceFamily,
            commands: nodeSession.commands,
            cfg: loadConfig(),
          }).catch((err) =>
            logGateway.warn(
              `remote bin probe failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
            ),
          );
          void loadVoiceWakeConfig()
            .then((cfg) => {
              context.nodeRegistry.sendEvent(nodeSession.nodeId, "voicewake.changed", {
                triggers: cfg.triggers,
              });
            })
            .catch((err) =>
              logGateway.warn(
                `voicewake snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
              ),
            );
        }

        logWs("out", "hello-ok", {
          connId,
          methods: gatewayMethods.length,
          events: events.length,
          presence: snapshot.presence.length,
          stateVersion: snapshot.stateVersion.presence,
        });

        send({ type: "res", id: frame.id, ok: true, payload: helloOk });
        void refreshGatewayHealthSnapshot({ probe: true }).catch((err) =>
          logHealth.error(`post-connect health refresh failed: ${formatError(err)}`),
        );
        return;
      }

      // After handshake, accept only req frames
      if (!validateRequestFrame(parsed)) {
        send({
          type: "res",
          id: (parsed as { id?: unknown })?.id ?? "invalid",
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`,
          ),
        });
        return;
      }
      const req = parsed;
      logWs("in", "req", { connId, id: req.id, method: req.method });
      const respond = (
        ok: boolean,
        payload?: unknown,
        error?: ErrorShape,
        meta?: Record<string, unknown>,
      ) => {
        send({ type: "res", id: req.id, ok, payload, error });
        logWs("out", "res", {
          connId,
          id: req.id,
          ok,
          method: req.method,
          errorCode: error?.code,
          errorMessage: error?.message,
          ...meta,
        });
      };

      void (async () => {
        await handleGatewayRequest({
          req,
          respond,
          client,
          isWebchatConnect,
          extraHandlers,
          context: buildRequestContext(),
        });
      })().catch((err) => {
        logGateway.error(`request handler failed: ${formatForLog(err)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
      });
    } catch (err) {
      logGateway.error(`parse/handle error: ${String(err)}`);
      logWs("out", "parse-error", { connId, error: formatForLog(err) });
      if (!getClient()) {
        close();
      }
    }
  });
}

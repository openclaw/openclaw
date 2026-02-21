import type { IncomingMessage } from "node:http";
import os from "node:os";
import type { WebSocket } from "ws";
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
import type { createSubsystemLogger } from "../../../logging/subsystem.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import { isGatewayCliClient, isWebchatClient } from "../../../utils/message-channel.js";
import { resolveRuntimeServiceVersion } from "../../../version.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
} from "../../auth-rate-limit.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "../../auth.js";
import {
  authorizeHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
  isLocalDirectRequest,
} from "../../auth.js";
import {
  buildCanvasScopedHostUrl,
  CANVAS_CAPABILITY_TTL_MS,
  mintCanvasCapabilityToken,
} from "../../canvas-capability.js";
import { buildDeviceAuthPayload } from "../../device-auth.js";
import { isLoopbackAddress, isTrustedProxyAddress, resolveClientIp } from "../../net.js";
import { resolveHostName } from "../../net.js";
import { resolveNodeCommandAllowlist } from "../../node-command-policy.js";
import { checkBrowserOrigin } from "../../origin-check.js";
import { GATEWAY_CLIENT_IDS } from "../../protocol/client-info.js";
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
import { parseGatewayRole } from "../../role-policy.js";
import { MAX_BUFFERED_BYTES, MAX_PAYLOAD_BYTES, TICK_INTERVAL_MS } from "../../server-constants.js";
import { handleGatewayRequest } from "../../server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { formatError } from "../../server-utils.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import {
  buildGatewaySnapshot,
  getHealthCache,
  getHealthVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "../health-state.js";
import type { GatewayWsClient } from "../ws-types.js";
import { formatGatewayAuthFailureMessage, type AuthProvidedKind } from "./auth-messages.js";
import {
  evaluateMissingDeviceIdentity,
  resolveControlUiAuthPolicy,
  shouldSkipControlUiPairing,
} from "./connect-policy.js";

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
  const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
  const clientIp = resolveClientIp({
    remoteAddr,
    forwardedFor,
    realIp,
    trustedProxies,
    allowRealIpFallback,
  });

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
  const isLocalClient = isLocalDirectRequest(upgradeReq, trustedProxies, allowRealIpFallback);
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
        const clientMeta = {
          client: connectParams.client.id,
          clientDisplayName: connectParams.client.displayName,
          mode: connectParams.client.mode,
          version: connectParams.client.version,
        };
        const markHandshakeFailure = (cause: string, meta?: Record<string, unknown>) => {
          setHandshakeState("failed");
          setCloseCause(cause, { ...meta, ...clientMeta });
        };
        const sendHandshakeErrorResponse = (
          code: Parameters<typeof errorShape>[0],
          message: string,
          options?: Parameters<typeof errorShape>[2],
        ) => {
          send({
            type: "res",
            id: frame.id,
            ok: false,
            error: errorShape(code, message, options),
          });
        };

        // protocol negotiation
        const { minProtocol, maxProtocol } = connectParams;
        if (maxProtocol < PROTOCOL_VERSION || minProtocol > PROTOCOL_VERSION) {
          markHandshakeFailure("protocol-mismatch", {
            minProtocol,
            maxProtocol,
            expectedProtocol: PROTOCOL_VERSION,
          });
          logWsControl.warn(
            `protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`,
          );
          sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "protocol mismatch", {
            details: { expectedProtocol: PROTOCOL_VERSION },
          });
          close(1002, "protocol mismatch");
          return;
        }

        const roleRaw = connectParams.role ?? "operator";
        const role = parseGatewayRole(roleRaw);
        if (!role) {
          markHandshakeFailure("invalid-role", {
            role: roleRaw,
          });
          sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "invalid role");
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
        if (isControlUi || isWebchat) {
          const originCheck = checkBrowserOrigin({
            requestHost,
            origin: requestOrigin,
            allowedOrigins: configSnapshot.gateway?.controlUi?.allowedOrigins,
          });
          if (!originCheck.ok) {
            const errorMessage =
              "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
            markHandshakeFailure("origin-mismatch", {
              origin: requestOrigin ?? "n/a",
              host: requestHost ?? "n/a",
              reason: originCheck.reason,
            });
            sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage);
            close(1008, truncateCloseReason(errorMessage));
            return;
          }
        }

        const deviceRaw = connectParams.device;
        let devicePublicKey: string | null = null;
        const hasTokenAuth = Boolean(connectParams.auth?.token);
        const hasPasswordAuth = Boolean(connectParams.auth?.password);
        const hasSharedAuth = hasTokenAuth || hasPasswordAuth;
        const controlUiAuthPolicy = resolveControlUiAuthPolicy({
          isControlUi,
          controlUiConfig: configSnapshot.gateway?.controlUi,
          deviceRaw,
        });
        const device = controlUiAuthPolicy.device;

        const resolveAuthState = async () => {
          const hasDeviceTokenCandidate = Boolean(connectParams.auth?.token && device);
          let nextAuthResult: GatewayAuthResult = await authorizeWsControlUiGatewayConnect({
            auth: resolvedAuth,
            connectAuth: connectParams.auth,
            req: upgradeReq,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter: hasDeviceTokenCandidate ? undefined : rateLimiter,
            clientIp,
            rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
          });

          if (
            hasDeviceTokenCandidate &&
            nextAuthResult.ok &&
            rateLimiter &&
            (nextAuthResult.method === "token" || nextAuthResult.method === "password")
          ) {
            const sharedRateCheck = rateLimiter.check(
              clientIp,
              AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
            );
            if (!sharedRateCheck.allowed) {
              nextAuthResult = {
                ok: false,
                reason: "rate_limited",
                rateLimited: true,
                retryAfterMs: sharedRateCheck.retryAfterMs,
              };
            } else {
              rateLimiter.reset(clientIp, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
            }
          }

          const nextAuthMethod =
            nextAuthResult.method ?? (resolvedAuth.mode === "password" ? "password" : "token");
          const sharedAuthResult = hasSharedAuth
            ? await authorizeHttpGatewayConnect({
                auth: { ...resolvedAuth, allowTailscale: false },
                connectAuth: connectParams.auth,
                req: upgradeReq,
                trustedProxies,
                allowRealIpFallback,
                // Shared-auth probe only; rate-limit side effects are handled in
                // the primary auth flow (or deferred for device-token candidates).
                rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
              })
            : null;
          const nextSharedAuthOk =
            sharedAuthResult?.ok === true &&
            (sharedAuthResult.method === "token" || sharedAuthResult.method === "password");

          return {
            authResult: nextAuthResult,
            authOk: nextAuthResult.ok,
            authMethod: nextAuthMethod,
            sharedAuthOk: nextSharedAuthOk,
          };
        };

        let { authResult, authOk, authMethod, sharedAuthOk } = await resolveAuthState();
        const rejectUnauthorized = (failedAuth: GatewayAuthResult) => {
          markHandshakeFailure("unauthorized", {
            authMode: resolvedAuth.mode,
            authProvided: connectParams.auth?.token
              ? "token"
              : connectParams.auth?.password
                ? "password"
                : "none",
            authReason: failedAuth.reason,
            allowTailscale: resolvedAuth.allowTailscale,
          });
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
          sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, authMessage);
          close(1008, truncateCloseReason(authMessage));
        };
        const clearUnboundScopes = () => {
          if (scopes.length > 0 && !controlUiAuthPolicy.allowBypass) {
            scopes = [];
            connectParams.scopes = scopes;
          }
        };
        const handleMissingDeviceIdentity = (): boolean => {
          if (!device) {
            clearUnboundScopes();
          }
          const decision = evaluateMissingDeviceIdentity({
            hasDeviceIdentity: Boolean(device),
            role,
            isControlUi,
            controlUiAuthPolicy,
            sharedAuthOk,
            authOk,
            hasSharedAuth,
            isLocalClient,
          });
          if (decision.kind === "allow") {
            return true;
          }

          if (decision.kind === "reject-control-ui-insecure-auth") {
            const errorMessage =
              "control ui requires device identity (use HTTPS or localhost secure context)";
            markHandshakeFailure("control-ui-insecure-auth", {
              insecureAuthConfigured: controlUiAuthPolicy.allowInsecureAuthConfigured,
            });
            sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage);
            close(1008, errorMessage);
            return false;
          }

          if (decision.kind === "reject-unauthorized") {
            rejectUnauthorized(authResult);
            return false;
          }

          markHandshakeFailure("device-required");
          sendHandshakeErrorResponse(ErrorCodes.NOT_PAIRED, "device identity required");
          close(1008, "device identity required");
          return false;
        };
        if (!handleMissingDeviceIdentity()) {
          return;
        }
        if (device) {
          const rejectDeviceAuthInvalid = (reason: string, message: string) => {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              reason,
              client: connectParams.client.id,
              deviceId: device.id,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, message),
            });
            close(1008, message);
          };
          const derivedId = deriveDeviceIdFromPublicKey(device.publicKey);
          if (!derivedId || derivedId !== device.id) {
            rejectDeviceAuthInvalid("device-id-mismatch", "device identity mismatch");
            return;
          }
          const signedAt = device.signedAt;
          if (
            typeof signedAt !== "number" ||
            Math.abs(Date.now() - signedAt) > DEVICE_SIGNATURE_SKEW_MS
          ) {
            rejectDeviceAuthInvalid("device-signature-stale", "device signature expired");
            return;
          }
          const nonceRequired = !isLocalClient;
          const providedNonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
          if (nonceRequired && !providedNonce) {
            rejectDeviceAuthInvalid("device-nonce-missing", "device nonce required");
            return;
          }
          if (providedNonce && providedNonce !== connectNonce) {
            rejectDeviceAuthInvalid("device-nonce-mismatch", "device nonce mismatch");
            return;
          }
          const payload = buildDeviceAuthPayload({
            deviceId: device.id,
            clientId: connectParams.client.id,
            clientMode: connectParams.client.mode,
            role,
            scopes,
            signedAtMs: signedAt,
            token: connectParams.auth?.token ?? null,
            nonce: providedNonce || undefined,
            version: providedNonce ? "v2" : "v1",
          });
          const rejectDeviceSignatureInvalid = () =>
            rejectDeviceAuthInvalid("device-signature", "device signature invalid");
          const signatureOk = verifyDeviceSignature(device.publicKey, payload, device.signature);
          const allowLegacy = !nonceRequired && !providedNonce;
          if (!signatureOk && allowLegacy) {
            const legacyPayload = buildDeviceAuthPayload({
              deviceId: device.id,
              clientId: connectParams.client.id,
              clientMode: connectParams.client.mode,
              role,
              scopes,
              signedAtMs: signedAt,
              token: connectParams.auth?.token ?? null,
              version: "v1",
            });
            if (verifyDeviceSignature(device.publicKey, legacyPayload, device.signature)) {
              // accepted legacy loopback signature
            } else {
              rejectDeviceSignatureInvalid();
              return;
            }
          } else if (!signatureOk) {
            rejectDeviceSignatureInvalid();
            return;
          }
          devicePublicKey = normalizeDevicePublicKeyBase64Url(device.publicKey);
          if (!devicePublicKey) {
            rejectDeviceAuthInvalid("device-public-key", "device public key invalid");
            return;
          }
        }

        if (!authOk && connectParams.auth?.token && device) {
          if (rateLimiter) {
            const deviceRateCheck = rateLimiter.check(clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
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
              token: connectParams.auth.token,
              role,
              scopes,
            });
            if (tokenCheck.ok) {
              authOk = true;
              authMethod = "device-token";
              rateLimiter?.reset(clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
            } else {
              authResult = { ok: false, reason: "device_token_mismatch" };
              rateLimiter?.recordFailure(clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
            }
          }
        }
        if (!authOk) {
          rejectUnauthorized(authResult);
          return;
        }

        const skipPairing = shouldSkipControlUiPairing(controlUiAuthPolicy, sharedAuthOk);
        if (device && devicePublicKey && !skipPairing) {
          const formatAuditList = (items: string[] | undefined): string => {
            if (!items || items.length === 0) {
              return "<none>";
            }
            const out = new Set<string>();
            for (const item of items) {
              const trimmed = item.trim();
              if (trimmed) {
                out.add(trimmed);
              }
            }
            if (out.size === 0) {
              return "<none>";
            }
            return [...out].toSorted().join(",");
          };
          const logUpgradeAudit = (
            reason: "role-upgrade" | "scope-upgrade",
            currentRoles: string[] | undefined,
            currentScopes: string[] | undefined,
          ) => {
            logGateway.warn(
              `security audit: device access upgrade requested reason=${reason} device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} roleFrom=${formatAuditList(currentRoles)} roleTo=${role} scopesFrom=${formatAuditList(currentScopes)} scopesTo=${formatAuditList(scopes)} client=${connectParams.client.id} conn=${connId}`,
            );
          };
          const requirePairing = async (
            reason: "not-paired" | "role-upgrade" | "scope-upgrade",
          ) => {
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
              silent: isLocalClient && reason === "not-paired",
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
                  details: { requestId: pairing.request.requestId },
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
            const pairedRoles = Array.isArray(paired.roles)
              ? paired.roles
              : paired.role
                ? [paired.role]
                : [];
            const pairedScopes = Array.isArray(paired.scopes)
              ? paired.scopes
              : Array.isArray(paired.approvedScopes)
                ? paired.approvedScopes
                : [];
            const allowedRoles = new Set(pairedRoles);
            if (allowedRoles.size === 0) {
              logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
              const ok = await requirePairing("role-upgrade");
              if (!ok) {
                return;
              }
            } else if (!allowedRoles.has(role)) {
              logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
              const ok = await requirePairing("role-upgrade");
              if (!ok) {
                return;
              }
            }

            if (scopes.length > 0) {
              if (pairedScopes.length === 0) {
                logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
                const ok = await requirePairing("scope-upgrade");
                if (!ok) {
                  return;
                }
              } else {
                const scopesAllowed = roleScopesAllow({
                  role,
                  requestedScopes: scopes,
                  allowedScopes: pairedScopes,
                });
                if (!scopesAllowed) {
                  logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
                  const ok = await requirePairing("scope-upgrade");
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

        const deviceToken = device
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
        const canvasCapability =
          role === "node" && canvasHostUrl ? mintCanvasCapabilityToken() : undefined;
        const canvasCapabilityExpiresAtMs = canvasCapability
          ? Date.now() + CANVAS_CAPABILITY_TTL_MS
          : undefined;
        const scopedCanvasHostUrl =
          canvasHostUrl && canvasCapability
            ? (buildCanvasScopedHostUrl(canvasHostUrl, canvasCapability) ?? canvasHostUrl)
            : canvasHostUrl;
        const helloOk = {
          type: "hello-ok",
          protocol: PROTOCOL_VERSION,
          server: {
            version: resolveRuntimeServiceVersion(process.env, "dev"),
            commit: process.env.GIT_COMMIT,
            host: os.hostname(),
            connId,
          },
          features: { methods: gatewayMethods, events },
          snapshot,
          canvasHostUrl: scopedCanvasHostUrl,
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
          canvasCapability,
          canvasCapabilityExpiresAtMs,
        };
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

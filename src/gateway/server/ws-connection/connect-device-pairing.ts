import {
  normalizeSortedUniqueTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import {
  buildPairingConnectCloseReason,
  buildPairingConnectErrorDetails,
  buildPairingConnectErrorMessage,
  ConnectErrorDetailCodes,
  type ConnectPairingRequiredReason,
} from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  approveBootstrapDevicePairing,
  approveDevicePairing,
} from "../../../infra/device-pairing-approval.js";
import { waitForDevicePairingResolution } from "../../../infra/device-pairing-resolution.js";
import {
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  listApprovedPairedDeviceRoles,
  listDevicePairing,
  listEffectivePairedDeviceRoles,
  requestDevicePairing,
  updatePairedDeviceMetadata,
} from "../../../infra/device-pairing.js";
import { isGatewayReadonlyWork } from "../../../process/gateway-work-admission.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import { isBrowserCopilotClient } from "../../../utils/message-channel.js";
import { pruneSupersededSilentPairingsAfterApproval } from "../../device-pairing-prune.js";
import { retireDeviceTokenClients } from "../../device-token-client-lifecycle.js";
import { normalizeNodeHostCompatibilityMetadata } from "../../node-legacy-protocol-filter.js";
import { isScopelessNodePairingRequest } from "../../node-pairing-auto-approve.js";
import { normalizeChromeExtensionOrigin } from "../../origin-check.js";
import { formatForLog } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import {
  applyConnectionScopeCap,
  isStartupNodeBootstrapConnect,
  rejectGatewayStartupConnect,
  resolveGatewayConnectPolicyFailure,
} from "./connect-admission.js";
import {
  pairedDeviceAllowsBootstrapProfile,
  resolvePairedAccessScopes,
  resolvePinnedClientMetadata,
} from "./connect-device-metadata.js";
import { issueGatewayConnectDeviceTokens } from "./connect-device-tokens.js";
import { authorizeExistingGatewayDevice } from "./connect-existing-device.js";
import { startGatewayNodePairingSshApproval } from "./connect-node-pairing-ssh.js";
import {
  resolveLocalPairingApproval,
  resolvePairingApprovalPlan,
} from "./connect-pairing-approval-plan.js";
import type {
  AuthenticatedGatewayConnect,
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

export async function authorizeGatewayConnectDevice(
  context: GatewayConnectPhaseContext,
  state: AuthenticatedGatewayConnect,
): Promise<DeviceAuthorizedGatewayConnect | undefined> {
  const {
    connId,
    buildRequestContext,
    close,
    setHandshakeState,
    setCloseCause,
    logGateway,
    requestOrigin,
  } = context.handler;
  const {
    sendHandshakeErrorResponse,
    connectParams,
    configSnapshot,
    reportedClientIp,
    reportedClientIpSource,
    hasBrowserOriginHeader,
  } = context;
  let { scopes } = state;
  let { handoffBootstrapProfile } = state;
  const {
    role,
    device,
    devicePublicKey,
    authMethod,
    authResult,
    hasRequestedScopes,
    skipLocalBackendSelfPairing,
    controlUiPairingKind,
  } = state;
  const isConnectAuthorizationCurrent = () =>
    resolveGatewayConnectPolicyFailure(context, state) === undefined;
  const failPairingHandshake = (params: {
    message: string;
    details?:
      | ReturnType<typeof buildPairingConnectErrorDetails>
      | { code: typeof ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED };
    closeCause?: { cause: string; meta: Record<string, unknown> };
    closeReason?: string;
  }) => {
    const { message, details, closeCause, closeReason } = params;
    setHandshakeState("failed");
    if (closeCause) {
      setCloseCause(closeCause.cause, closeCause.meta);
    }
    sendHandshakeErrorResponse(ErrorCodes.NOT_PAIRED, message, details ? { details } : undefined);
    close(1008, truncateCloseReason(closeReason ?? message));
  };
  const roleConfiguredHumanOperator = role === "operator" && Boolean(configSnapshot.gateway?.roles);
  const sharedSecretOwner = authMethod === "token" || authMethod === "password";
  if (roleConfiguredHumanOperator && !sharedSecretOwner && !authResult.user?.trim()) {
    failPairingHandshake({
      message:
        "operator role policies require a verified user identity for this authentication method; reconnect through the trusted proxy or Tailscale, or use the shared gateway token/password",
      details: { code: ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED },
    });
    return undefined;
  }
  let hasServerApprovedDeviceTokenBaseline = false;
  let pairedClientId: string | undefined;
  let pairedBrowserOrigin: string | undefined;
  // Canonicalize protocol-v3 desktop aliases before pairing persistence and comparison.
  connectParams.client = normalizeNodeHostCompatibilityMetadata(connectParams.client);
  const browserCopilotOrigin = isBrowserCopilotClient(connectParams.client)
    ? normalizeChromeExtensionOrigin(requestOrigin)
    : undefined;
  if (device && devicePublicKey) {
    const formatAuditList = (items: string[] | undefined): string =>
      normalizeSortedUniqueTrimmedStringList(items).join(",") || "<none>";
    const logUpgradeAudit = (
      reason: "role-upgrade" | "scope-upgrade",
      currentRoles: string[] | undefined,
      currentScopes: string[] | undefined,
    ) =>
      logGateway.warn(
        `security audit: device access upgrade requested reason=${reason} device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} roleFrom=${formatAuditList(currentRoles)} roleTo=${role} scopesFrom=${formatAuditList(currentScopes)} scopesTo=${formatAuditList(scopes)} client=${connectParams.client.id} conn=${connId}`,
      );
    const clientPairingMetadata = {
      displayName: connectParams.client.displayName,
      platform: connectParams.client.platform,
      deviceFamily: connectParams.client.deviceFamily,
      clientId: connectParams.client.id,
      clientMode: connectParams.client.mode,
      ...(browserCopilotOrigin ? { browserOrigin: browserCopilotOrigin } : {}),
      role,
      scopes,
      remoteIp: reportedClientIp,
    };
    const clientAccessMetadata = {
      displayName: connectParams.client.displayName,
      remoteIp: reportedClientIp,
      lastSeenAtMs: Date.now(),
      lastSeenReason: "connect",
    };
    const requirePairing = async (
      reason: ConnectPairingRequiredReason,
      existingPairedDevice: Awaited<ReturnType<typeof getPairedDevice>> | null = null,
    ) => {
      if (isGatewayReadonlyWork()) {
        failPairingHandshake({
          message:
            "Device approval cannot change during Gateway reader retirement. Reconnect to the replacement Gateway.",
        });
        return false;
      }
      const pairingStateAllowsRequestedAccess = (
        pairedCandidate: Awaited<ReturnType<typeof getPairedDevice>>,
        requestedScopes = scopes,
      ): boolean =>
        pairedCandidate?.publicKey === devicePublicKey &&
        hasEffectivePairedDeviceRole(pairedCandidate, role) &&
        roleScopesAllow({
          role,
          requestedScopes,
          allowedScopes: resolvePairedAccessScopes(pairedCandidate),
        });
      const pairingPlanParams = {
        reason,
        existingPairedDevice,
        state,
        connectParams,
        configSnapshot,
        hasBrowserOriginHeader,
        reportedClientIp,
        reportedClientIpSource,
        deviceId: device.id,
        devicePublicKey,
        scopes,
        hasRequestedScopes,
        connectionScopeCap: (capped: string[]) =>
          applyConnectionScopeCap({ scopes: capped, upgradeReq: context.handler.upgradeReq }),
      };
      const plan = await resolvePairingApprovalPlan(pairingPlanParams);
      // Same-key reconnects reuse paired grants without pairing or false upgrade audits.
      if (
        reason === "scope-upgrade" &&
        plan.isTrustedProxySameKeyUpgrade &&
        plan.trustedProxyAutoApproveScopes !== null
      ) {
        // Authority is the live row, not the pre-plan snapshot: a revoke, key
        // replacement, or grant reduction landing during the plan await must
        // fail this check and fall through to the pairing lane. Last await
        // before the decision; keep the return synchronous after it.
        const livePaired = await getPairedDevice(device.id);
        if (
          livePaired &&
          pairingStateAllowsRequestedAccess(livePaired, plan.trustedProxyAutoApproveScopes)
        ) {
          const livePairedScopes = resolvePairedAccessScopes(livePaired);
          scopes = normalizeSortedUniqueTrimmedStringList(
            [...scopes, ...plan.trustedProxyAutoApproveScopes].filter((scope) =>
              roleScopesAllow({ role, requestedScopes: [scope], allowedScopes: livePairedScopes }),
            ),
          );
          connectParams.scopes = scopes;
          return true;
        }
      }
      if (reason === "role-upgrade" || reason === "scope-upgrade") {
        logUpgradeAudit(
          reason,
          existingPairedDevice ? listEffectivePairedDeviceRoles(existingPairedDevice) : undefined,
          existingPairedDevice ? resolvePairedAccessScopes(existingPairedDevice) : undefined,
        );
      }
      const waitForResolution = state.isControlUi && role === "operator";
      const pairingAbort = new AbortController();
      const cancelPairingWait = () => pairingAbort.abort();
      let resolution: ReturnType<typeof waitForDevicePairingResolution> | undefined;
      const pairing = await requestDevicePairing(
        {
          deviceId: device.id,
          publicKey: devicePublicKey,
          ...clientPairingMetadata,
          scopes,
          ...(plan.bootstrapPairingRoles
            ? {
                roles: plan.bootstrapPairingRoles,
                scopes: plan.bootstrapPairingScopes ?? [],
              }
            : {}),
          silent: plan.silent,
        },
        undefined,
        waitForResolution
          ? (pending) => {
              context.handler.socket.once("close", cancelPairingWait);
              resolution = waitForDevicePairingResolution(pending.request, {
                expiresAtMs: pending.expiresAtMs,
                signal: pairingAbort.signal,
              }).finally(() => context.handler.socket.off("close", cancelPairingWait));
              if (context.handler.isClosed()) {
                cancelPairingWait();
              }
            }
          : undefined,
      );
      const trustedProxyApprovalScopes =
        pairing.request.isRepair !== true || plan.isTrustedProxySameKeyUpgrade
          ? plan.trustedProxyAutoApproveScopes
          : null;
      const requestContext = buildRequestContext();
      // A replacement request obsoletes older pending requestIds; tell approval
      // UIs so they drop the stale prompts instead of stacking alerts forever.
      const supersededResolvedAt = Date.now();
      for (const superseded of pairing.superseded ?? []) {
        requestContext.broadcast(
          "device.pair.resolved",
          {
            requestId: superseded.requestId,
            deviceId: superseded.deviceId,
            decision: "rejected",
            ts: supersededResolvedAt,
          },
          { dropIfSlow: true },
        );
      }
      let approved: Awaited<ReturnType<typeof approveDevicePairing>> | undefined;
      const inlineApprovalAttempted =
        trustedProxyApprovalScopes !== null ||
        pairing.request.silent === true ||
        // A previously interactive first-node request may now qualify locally.
        (role === "node" && reason === "role-upgrade" && plan.localApproval === "silent");
      if (inlineApprovalAttempted) {
        if (trustedProxyApprovalScopes !== null) {
          approved = await approveDevicePairing(pairing.request.requestId, {
            callerScopes: trustedProxyApprovalScopes,
            accessMetadata: clientAccessMetadata,
            approvedVia: "trusted-proxy",
            autoApproveNewDeviceScopes: trustedProxyApprovalScopes,
            isApprovalCurrent: isConnectAuthorizationCurrent,
          });
        } else if (plan.bootstrapApprovalProfile) {
          approved = await approveBootstrapDevicePairing(
            pairing.request.requestId,
            plan.bootstrapApprovalProfile,
            {
              accessMetadata: clientAccessMetadata,
              isApprovalCurrent: isConnectAuthorizationCurrent,
              onTokensReplaced: (deviceId, roles) =>
                retireDeviceTokenClients(requestContext, deviceId, roles, "device-token-rotated"),
            },
          );
        } else if (plan.localApproval) {
          approved = await approveDevicePairing(pairing.request.requestId, {
            // A silent self-grant's authority is locality plus proven
            // local-grade auth, not the requested scope list. Approval
            // merges the existing row's scopes back in, so the caller
            // set must cover requested plus already-held — nothing new.
            callerScopes: uniqueStrings([
              ...scopes,
              ...(existingPairedDevice ? resolvePairedAccessScopes(existingPairedDevice) : []),
            ]),
            accessMetadata: clientAccessMetadata,
            // Same-host local approvals are prune-eligible "silent";
            // trusted-CIDR approvals cross hosts and must never be
            // auto-pruned, so they carry their own provenance.
            approvedVia: plan.localApproval,
            isApprovalCurrent: ({ pending, existing }) => {
              const currentConfig = getRuntimeConfigSnapshot();
              if (
                !currentConfig ||
                !isConnectAuthorizationCurrent() ||
                pending.deviceId !== device.id ||
                pending.publicKey !== devicePublicKey ||
                // Pending retries can merge roles; a node connect cannot approve
                // an unrelated operator request carried by the same pending row.
                (role === "node" &&
                  (pending.role !== role || pending.roles?.some((entry) => entry !== role))) ||
                (plan.localApproval === "trusted-cidr" && !isScopelessNodePairingRequest(pending))
              ) {
                return false;
              }
              return (
                resolveLocalPairingApproval({
                  ...pairingPlanParams,
                  configSnapshot: currentConfig,
                  existingPairedDevice: existing ?? null,
                  scopes: pending.scopes ?? [],
                }) === plan.localApproval
              );
            },
          });
        }
        if (approved?.status === "approved") {
          if (trustedProxyApprovalScopes !== null) {
            scopes = trustedProxyApprovalScopes;
            connectParams.scopes = scopes;
          }
          if (plan.bootstrapApprovalProfile) {
            handoffBootstrapProfile = plan.bootstrapApprovalProfile;
          }
          if (trustedProxyApprovalScopes !== null && plan.trustedProxyUser) {
            logGateway.warn(
              `security audit: trusted-proxy operator device auto-approved user=${formatForLog(plan.trustedProxyUser)} device=${formatForLog(approved.device.deviceId.slice(0, 12))} scopes=${formatAuditList(scopes)}`,
            );
          } else {
            logGateway.info(
              `device pairing auto-approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
            );
          }
          requestContext.broadcast(
            "device.pair.resolved",
            {
              requestId: pairing.request.requestId,
              deviceId: approved.device.deviceId,
              decision: "approved",
              ts: Date.now(),
            },
            { dropIfSlow: true },
          );
          if (!plan.allowSetupCodeHandoffBootstrapPairing) {
            // Best-effort retirement of stale silent siblings; a prune
            // failure must never fail the fresh device's handshake.
            try {
              await pruneSupersededSilentPairingsAfterApproval({
                deviceId: approved.device.deviceId,
                context: requestContext,
              });
            } catch (error) {
              logGateway.warn(
                `device pairing prune failed device=${approved.device.deviceId} error=${String(error)}`,
              );
            }
          }
        }
      } else if (pairing.created) {
        requestContext.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
      }
      // SSH verification runs detached; the live-record check below can admit
      // an approval that finishes before this handshake's final check.
      const sshVerifyStarted = startGatewayNodePairingSshApproval({
        context,
        state: { ...state, scopes, handoffBootstrapProfile },
        pairing,
        existingPairedDevice,
        devicePublicKey,
        clientAccessMetadata,
        reason,
      });
      // Re-resolve: another connection may have superseded/approved the request since we created it
      const { pending } = await listDevicePairing();
      const recoveryRequestId = (
        pending.find((entry) => entry.requestId === pairing.request.requestId) ??
        pending.find((entry) => entry.deviceId === device.id && entry.publicKey === devicePublicKey)
      )?.requestId;
      // Approval may come from another connection or be revoked during the
      // awaits above. Only the current device record can authorize continuation.
      const livePaired = await getPairedDevice(device.id);
      const liveMetadata = resolvePinnedClientMetadata({
        clientId: connectParams.client.id,
        clientMode: connectParams.client.mode,
        claimedPlatform: connectParams.client.platform,
        claimedDeviceFamily: connectParams.client.deviceFamily,
        pairedPlatform: livePaired?.platform,
        pairedDeviceFamily: livePaired?.deviceFamily,
      });
      const pairingResolved =
        !liveMetadata.platformMismatch &&
        !liveMetadata.deviceFamilyMismatch &&
        (plan.bootstrapApprovalProfile
          ? pairedDeviceAllowsBootstrapProfile({
              device: livePaired,
              devicePublicKey,
              profile: plan.bootstrapApprovalProfile,
            })
          : pairingStateAllowsRequestedAccess(livePaired));
      if (!pairingResolved) {
        if (inlineApprovalAttempted && recoveryRequestId === pairing.request.requestId) {
          requestContext.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
        }
        const exposeApprovedAccess = existingPairedDevice?.publicKey === devicePublicKey;
        const approvedRoles = exposeApprovedAccess
          ? listApprovedPairedDeviceRoles(existingPairedDevice)
          : [];
        const approvedScopes = exposeApprovedAccess
          ? resolvePairedAccessScopes(existingPairedDevice)
          : [];
        const retryAfterBootstrapPairingApproval =
          authMethod === "bootstrap-token" &&
          reason === "not-paired" &&
          role === "node" &&
          scopes.length === 0 &&
          !existingPairedDevice;
        const retryWhileControlUiApprovalPending =
          state.isControlUi && role === "operator" && Boolean(recoveryRequestId);
        const retryWhileNodeApprovalPending = role === "node" && Boolean(recoveryRequestId);
        // Retry pending node and browser approvals without
        // changing which connects require approval or what access they receive.
        const retryWhileApprovalPending =
          retryAfterBootstrapPairingApproval ||
          sshVerifyStarted ||
          retryWhileNodeApprovalPending ||
          retryWhileControlUiApprovalPending;
        const details = buildPairingConnectErrorDetails({
          reason,
          requestId: resolution ? pairing.request.requestId : recoveryRequestId,
          ...(resolution || retryWhileApprovalPending
            ? {
                recommendedNextStep: "wait_then_retry",
                retryable: true,
                pauseReconnect: false,
              }
            : {}),
          ...(resolution ? { waitForResolution: true } : {}),
          deviceId: device.id,
          requestedRole: role,
          requestedScopes: scopes,
          ...(approvedRoles.length > 0 ? { approvedRoles } : {}),
          ...(approvedScopes.length > 0 ? { approvedScopes } : {}),
        });
        if (resolution) {
          context.onPairingWait();
          sendHandshakeErrorResponse(
            ErrorCodes.NOT_PAIRED,
            buildPairingConnectErrorMessage(reason),
            { details },
          );
          void resolution.then((decision) => {
            if (!decision || context.handler.isClosed()) {
              return;
            }
            if (decision !== "superseded") {
              context.handler.send({
                type: "event",
                event: "device.pair.resolved",
                payload: {
                  requestId: pairing.request.requestId,
                  deviceId: device.id,
                  decision,
                  ts: Date.now(),
                },
              });
            }
            close(1008, `pairing ${decision}`);
          });
          return false;
        }
        failPairingHandshake({
          message: buildPairingConnectErrorMessage(reason),
          details,
          closeCause: {
            cause: "pairing-required",
            meta: {
              deviceId: device.id,
              ...(recoveryRequestId ? { requestId: recoveryRequestId } : {}),
              reason,
            },
          },
          closeReason: buildPairingConnectCloseReason({ reason, requestId: recoveryRequestId }),
        });
        return false;
      }
      cancelPairingWait();
      pairedClientId = livePaired?.clientId;
      pairedBrowserOrigin = livePaired?.browserOrigin;
      return true;
    };

    const paired = await getPairedDevice(device.id);
    const isPaired = paired?.publicKey === devicePublicKey;
    if (
      state.startupPending &&
      !isStartupNodeBootstrapConnect(connectParams) &&
      (!paired || !isPaired || !hasEffectivePairedDeviceRole(paired, "node") || !paired.nodeSurface)
    ) {
      await rejectGatewayStartupConnect(context);
      return undefined;
    }
    const pairingRecordDoesNotAuthorizeSession =
      skipLocalBackendSelfPairing || controlUiPairingKind === "auth-none";
    if (pairingRecordDoesNotAuthorizeSession) {
      if (isPaired) {
        // Locality plus auth mode authorizes this session; the pairing row only
        // bounds durable grants and owns last-seen diagnostics. Reapplying its
        // scope cap here would make an unrelated narrow row deny local access.
        pairedClientId = paired.clientId;
        pairedBrowserOrigin = paired.browserOrigin;
        hasServerApprovedDeviceTokenBaseline = true;
        if (!isGatewayReadonlyWork()) {
          await updatePairedDeviceMetadata(device.id, clientAccessMetadata);
        }
      } else if (
        controlUiPairingKind === "auth-none" ||
        (skipLocalBackendSelfPairing && authMethod !== "device-token")
      ) {
        hasServerApprovedDeviceTokenBaseline = true;
      }
    } else if (!isPaired) {
      if (controlUiPairingKind === null && !(await requirePairing("not-paired", paired))) {
        return undefined;
      }
      hasServerApprovedDeviceTokenBaseline = true;
    } else {
      pairedClientId = paired.clientId;
      pairedBrowserOrigin = paired.browserOrigin;
      hasServerApprovedDeviceTokenBaseline = true;
      const existingDevice = await authorizeExistingGatewayDevice({
        context,
        state: { ...state, scopes, handoffBootstrapProfile },
        paired,
        devicePublicKey,
        clientAccessMetadata,
        requirePairing,
      });
      if (!existingDevice.ok) {
        return undefined;
      }
      handoffBootstrapProfile = existingDevice.handoffBootstrapProfile;
    }
  }

  const browserCopilotIdentityMismatch =
    pairedClientId !== connectParams.client.id &&
    (isBrowserCopilotClient(connectParams.client) ||
      isBrowserCopilotClient({ id: pairedClientId }));
  const browserCopilotOriginMismatch =
    isBrowserCopilotClient(connectParams.client) &&
    (!pairedBrowserOrigin || !browserCopilotOrigin || pairedBrowserOrigin !== browserCopilotOrigin);
  if (browserCopilotIdentityMismatch || browserCopilotOriginMismatch) {
    const message = "browser copilot requires a dedicated paired device identity";
    failPairingHandshake({ message });
    return undefined;
  }

  // Device tokens do not carry profile identity and existing broader grants may be reused.
  // Team-role operators must reauthenticate as their verified person on every connection.
  const { deviceToken, bootstrapDeviceTokens } =
    roleConfiguredHumanOperator && authResult.user?.trim()
      ? { deviceToken: null, bootstrapDeviceTokens: [] }
      : await issueGatewayConnectDeviceTokens({
          state: { ...state, scopes, handoffBootstrapProfile },
          scopes,
          hasApprovedDeviceBaseline: hasServerApprovedDeviceTokenBaseline,
          isIssuanceCurrent: isConnectAuthorizationCurrent,
        });

  return {
    ...state,
    scopes,
    handoffBootstrapProfile,
    deviceToken,
    bootstrapDeviceTokens,
  };
}

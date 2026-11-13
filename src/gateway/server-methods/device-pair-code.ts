import {
  ErrorCodes,
  errorShape,
  validateDevicePairCodeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  decideBrowserPairRequest,
  inspectBrowserPairRequest,
} from "../../infra/device-pairing-browser-code.js";
import {
  BROWSER_PAIR_IDENTITY_REQUIRED_MESSAGE,
  normalizeBrowserPairCode,
} from "../../shared/browser-pair.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { retireDeviceTokenClients } from "../device-token-client-lifecycle.js";
import { isNamedOperatorRoleEnforcementEnabled } from "../operator-role-enforcement.js";
import { broadcastRejectedDevicePairing } from "../pairing-events.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { resolveDeviceSessionAuthz } from "./device-management-authz.js";
import { respondUnavailableOnThrow } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { preparePersonalDeviceAdministration } from "./users-profile-access.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const REFUSALS = {
  unknown: "No browser is waiting for this code. Check the code shown in the browser.",
  expired: "This code has expired. Choose Pair this browser again to get a new one.",
  decided: "This code was already answered. Choose Pair this browser again to get a new one.",
} as const;

function formatReducedRefusal(deviceId: string): string {
  return (
    "This browser is already paired with revoked or narrower access, and a code does not lift that limit. " +
    "To restore administrator access, run `openclaw dashboard` on the Gateway host and open its link in that browser, " +
    `or run \`openclaw devices remove ${deviceId}\` and pair again.`
  );
}

export const devicePairCodeHandlers: GatewayRequestHandlers = {
  "device.pair.code": defineValidatedGatewayHandler(
    "device.pair.code",
    validateDevicePairCodeParams,
    async (options) => {
      const { params, respond, context, client } = options;
      await respondUnavailableOnThrow(respond, async () => {
        const { requestId, decision } = params;
        const profileId = params.profileId?.trim();
        if (
          params.profileId !== undefined &&
          (!profileId || decision !== "approve" || !requestId)
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "A person may be selected only for an explicit approval",
            ),
          );
          return;
        }
        const code = normalizeBrowserPairCode(params.code);
        if (!code || Boolean(requestId) !== Boolean(decision)) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, REFUSALS.unknown));
          return;
        }
        const authority = {
          context: captureOpenClawStateWorkerContext(),
          assertCurrent: readGatewayRequestMutationAuthority(options).assertCurrent,
        };
        const refuse = (message: string) =>
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
        if (!requestId || !decision) {
          const inspected = await inspectBrowserPairRequest({ code, ...authority });
          if (!("requestId" in inspected)) {
            refuse(REFUSALS[inspected.status]);
            return;
          }
          respond(true, inspected, undefined);
          return;
        }
        const assertAdmin = profileId
          ? await preparePersonalDeviceAdministration(options)
          : undefined;
        // A code proves the key; explicit administrator selection attests the person.
        const assertPairingSupported = () => {
          authority.assertCurrent();
          assertAdmin?.();
          if (
            decision === "approve" &&
            !profileId &&
            isNamedOperatorRoleEnforcementEnabled(context.getRuntimeConfig())
          ) {
            throw new Error(BROWSER_PAIR_IDENTITY_REQUIRED_MESSAGE);
          }
        };
        assertPairingSupported();
        if (profileId && client?.connect.device?.id) {
          const target = await inspectBrowserPairRequest({ code, ...authority });
          assertPairingSupported();
          if ("deviceId" in target && target.deviceId === client.connect.device.id) {
            holdGatewayPolicyResponse(respond);
          }
        }
        const decided = await decideBrowserPairRequest({
          code,
          requestId,
          decision,
          callerScopes: resolveDeviceSessionAuthz(client).callerScopes,
          ...(profileId ? { operatorProfileId: profileId } : {}),
          // Browser tokens follow shared-secret rotation like those issued at connect.
          readSharedGatewaySessionGeneration: () =>
            context.sharedGatewaySessionGenerationState?.requiredGeneration,
          ...authority,
          assertCurrent: assertPairingSupported,
        });
        if (decided.status === "reduced") {
          refuse(formatReducedRefusal(decided.deviceId));
          return;
        }
        if (!("requestId" in decided)) {
          refuse(REFUSALS[decided.status]);
          return;
        }
        // The result schema is closed; superseded handshakes are announced, not returned.
        const { superseded, ...request } = decided;
        if (request.status === "approved") {
          if (profileId) {
            retireDeviceTokenClients(
              context,
              request.deviceId,
              ["operator"],
              "device-token-rotated",
            );
          }
          const resolvedAt = Date.now();
          for (const pairing of superseded) {
            broadcastRejectedDevicePairing(context.broadcast, pairing, resolvedAt);
          }
          context.logGateway.info(`browser pairing approved device=${request.deviceId}`);
        }
        respond(true, request, undefined);
      });
    },
  ),
};

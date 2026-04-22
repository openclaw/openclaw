import { extractDeliveryInfo } from "../../config/sessions.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
} from "../../infra/restart-sentinel.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import { validateGatewayRestartParams } from "../protocol/index.js";
import { requestGatewayRestartTransaction } from "../restart-transaction.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const restartHandlers: GatewayRequestHandlers = {
  "gateway.restart": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateGatewayRestartParams, "gateway.restart", respond)) {
      return;
    }

    const actor = resolveControlPlaneActor(client);
    const {
      sessionKey,
      deliveryContext: requestedDeliveryContext,
      threadId: requestedThreadId,
      note,
      reason,
      restartDelayMs,
    } = parseRestartRequestParams(params);
    const { deliveryContext: sessionDeliveryContext, threadId: sessionThreadId } =
      extractDeliveryInfo(sessionKey);
    const payload: RestartSentinelPayload = {
      kind: "restart",
      status: "ok",
      ts: Date.now(),
      sessionKey,
      deliveryContext: requestedDeliveryContext ?? sessionDeliveryContext,
      threadId: requestedThreadId ?? sessionThreadId,
      message: note ?? null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: "gateway.restart",
        reason: reason ?? "gateway.restart",
      },
    };

    const result = await requestGatewayRestartTransaction({
      payload,
      requester: {
        actor: actor.actor,
        deviceId: actor.deviceId,
        clientIp: actor.clientIp,
        entryPoint: "gateway.restart",
      },
      entryPoint: "gateway.restart",
      reason: reason ?? "gateway.restart",
      restartDelayMs,
    });

    context?.logGateway?.info(
      `gateway.restart ${formatControlPlaneActor(actor)} mode=${result.mode} delayMs=${result.restart.delayMs} coalesced=${result.restart.coalesced}`,
    );

    respond(
      true,
      {
        ok: true,
        mode: result.mode,
        restart: result.restart,
        transaction: result.transaction,
        sentinel: {
          path: result.sentinelPath,
          payload: {
            ...payload,
            transaction: result.transaction,
          },
        },
      },
      undefined,
    );
  },
};

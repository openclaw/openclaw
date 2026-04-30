import {
  createSessionShareToken,
  revokeSessionShareToken,
} from "../../infra/session-share-tokens.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCreateSharedTokenParams,
  validateSessionsRevokeSharedTokenParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionShareTokenHandlers: GatewayRequestHandlers = {
  "sessions.createSharedToken": ({ params, client, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCreateSharedTokenParams,
        "sessions.createSharedToken",
        respond,
      )
    ) {
      return;
    }
    const deviceId = client?.connect?.device?.id ?? "";
    const entry = createSessionShareToken({
      sessionKey: params.sessionKey,
      ttlMs: params.ttlMs,
      createdByDeviceId: deviceId,
    });
    respond(true, {
      ok: true,
      token: entry.token,
      sessionKey: entry.sessionKey,
      expiresAtMs: entry.expiresAtMs,
    });
  },

  "sessions.revokeSharedToken": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsRevokeSharedTokenParams,
        "sessions.revokeSharedToken",
        respond,
      )
    ) {
      return;
    }
    const revoked = revokeSessionShareToken(params.token);
    if (!revoked) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "token not found"));
      return;
    }
    respond(true, { ok: true });
  },
};

import {
  ErrorCodes,
  errorShape,
  validateTalkSessionAcknowledgeMarkParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { formatForLog } from "../../ws-log.js";
import { acknowledgeTalkRealtimeRelayMark } from "../relay/index.js";
import { getUnifiedTalkSession, requireUnifiedTalkSessionConn } from "../session-registry.js";

export const acknowledgeTalkSessionMark = defineValidatedGatewayHandler(
  "talk.session.acknowledgeMark",
  validateTalkSessionAcknowledgeMarkParams,
  ({ params, respond, client }) => {
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "talk.session.acknowledgeMark requires realtime relay",
          ),
        );
        return;
      }
      acknowledgeTalkRealtimeRelayMark({
        relaySessionId: session.relaySessionId,
        connId: requireUnifiedTalkSessionConn(session, client?.connId),
        markName: params.markName,
      });
      respond(true, { ok: true }, undefined);
    } catch (error) {
      const message = formatForLog(error);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, message, {
          details: {
            talkIssue: { code: "realtime_unavailable", message, phase: "request" },
          },
        }),
      );
    }
  },
);

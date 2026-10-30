import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { callGateway } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/operator-scopes.js";

export function resolveAgentGatewayIdentity(
  needsAdmin: boolean,
  remoteGateway: boolean,
  deliver?: boolean,
): Pick<Parameters<typeof callGateway>[0], "caps" | "clientName" | "mode" | "scopes"> {
  return {
    clientName: needsAdmin ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI,
    mode: needsAdmin ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.CLI,
    // Overrides/resets require admin; otherwise only the local operator requests
    // owner scope, and remote callers keep the agent method's least-privilege scope.
    ...(needsAdmin || !remoteGateway ? { scopes: [ADMIN_SCOPE] } : {}),
    // The terminal cannot answer structured questions, so the agent asks in text.
    // Delivered runs keep the delivery channel's question support.
    ...(deliver ? {} : { caps: [GATEWAY_CLIENT_CAPS.NO_QUESTION_INPUT] }),
  };
}

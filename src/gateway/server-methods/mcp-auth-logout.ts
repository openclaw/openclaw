import {
  ErrorCodes,
  errorShape,
  validateMcpAuthLogoutParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { operatorMcpOAuthIdentity } from "../../agents/mcp-oauth-identity.js";
import { clearMcpOAuthCredentials } from "../../agents/mcp-oauth.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { resolveOperatorMcpOAuthConnection } from "../../plugins/mcp-auth-status.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const mcpAuthLogoutHandlers: GatewayRequestHandlers = {
  "mcp.authLogout": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateMcpAuthLogoutParams, "mcp.authLogout", respond)) {
      return;
    }
    // Resolve exactly the connection mcp.authLogin signs in, including plugin-declared
    // servers that the offline CLI cannot see. Running MCP clients read tokens from the
    // store on each request, so their next call needs a new sign-in.
    const connection = resolveOperatorMcpOAuthConnection({
      config: context.getRuntimeConfig(),
      metadata: getGatewayPluginMetadataSnapshot(),
      serverName: params.serverName,
    });
    if (!connection) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "This MCP server has no operator sign-in to clear. Check its existing account settings.",
        ),
      );
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      await clearMcpOAuthCredentials(
        operatorMcpOAuthIdentity(params.serverName, connection.config.url),
      );
      respond(true, { serverName: params.serverName });
    });
  },
};

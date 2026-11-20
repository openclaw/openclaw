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
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const mcpAuthLogoutHandlers: GatewayRequestHandlers = {
  "mcp.authLogout": async (options) => {
    const { params, respond, context, client } = options;
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
    const request = readGatewayRequestMutationAuthority(options);
    // The credential lease can wait behind another sign-in; the caller must still be an
    // administrator when the row is cleared.
    const assertCurrent = () => {
      request.assertCurrent();
      if (!client?.connect.scopes?.includes("operator.admin")) {
        throw new Error("Sign-out requires an administrator connection.");
      }
    };
    await respondUnavailableOnThrow(respond, async () => {
      await clearMcpOAuthCredentials(
        operatorMcpOAuthIdentity(params.serverName, connection.config.url),
        { assertCurrent, ...(options.signal ? { signal: options.signal } : {}) },
      );
      respond(true, { serverName: params.serverName });
    });
  },
};

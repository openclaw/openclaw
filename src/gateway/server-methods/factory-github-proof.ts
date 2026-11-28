import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { redeemFactoryGitHubProof } from "../factory-github-proof.js";
import { respondError } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";

export const factoryGitHubProofHandlers: GatewayRequestHandlers = {
  "factory.githubPublication.redeem": (options) => {
    const { client, context, params, respond } = options;
    // Direct-local is handshake provenance. A public proxy's loopback socket is not this client.
    if (
      process.env.FACTORY_AUTH_MODE !== "github" ||
      client?.internal?.isLocalClient !== true ||
      client.internal.authenticatedOperator !== true ||
      client.internal.operatorRoleActor?.kind !== "system" ||
      client.connect.role !== "operator" ||
      !client.connect.scopes?.includes("operator.admin") ||
      !client.connId ||
      context.isConnectionActive?.(client.connId) === false
    ) {
      respondError(
        respond,
        ErrorCodes.FORBIDDEN,
        "Private GitHub proof redemption is unavailable.",
      );
      return;
    }
    const proof =
      params && typeof params === "object" && "proof" in params ? params.proof : undefined;
    if (
      !params ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      Object.keys(params).length !== 1 ||
      typeof proof !== "string"
    ) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "GitHub proof request is invalid.");
      return;
    }
    try {
      const authority = readGatewayRequestMutationAuthority(options);
      authority.assertCurrent();
      const verdict = redeemFactoryGitHubProof(proof);
      authority.assertCurrent();
      if (context.isConnectionActive?.(client.connId) === false) {
        throw new Error("Private GitHub proof caller is no longer active.");
      }
      respond(true, verdict);
    } catch {
      respondError(respond, ErrorCodes.FORBIDDEN, "GitHub proof is unavailable.");
    }
  },
};

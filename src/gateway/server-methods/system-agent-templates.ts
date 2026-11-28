import {
  withSystemAgentTemplateGateway,
  type SystemAgentTemplateGateway,
} from "../../system-agent/template-gateway.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import {
  applyTemplateAddForRequest,
  planTemplateAddForRequest,
  reportTemplateAddFailure,
} from "./templates-add.js";
import type { GatewayRequestHandler } from "./types.js";

/** Keep Template effects on the requesting administrator, including after approval. */
export function withSystemAgentTemplateRequests(
  handler: GatewayRequestHandler,
): GatewayRequestHandler {
  return async (options) => {
    const authority = readGatewayRequestMutationAuthority(options);
    const assertCurrent = () => {
      authority.assertCurrent();
      const client = options.client;
      if (
        !client ||
        client.invalidated ||
        (client.connect.role ?? "operator") !== "operator" ||
        !client.connect.scopes?.includes(ADMIN_SCOPE)
      ) {
        throw new Error(
          "Adding a Template requires an active administrator connection (operator.admin). Ask a Gateway administrator to review and install it in Pages → Templates or Settings → Ask OpenClaw.",
        );
      }
    };
    const gateway: SystemAgentTemplateGateway = {
      review: async (params) => {
        assertCurrent();
        const result = await planTemplateAddForRequest({ ...options, params }).catch(
          (error: unknown) => {
            throw new Error(reportTemplateAddFailure(error, "plan"), { cause: error });
          },
        );
        assertCurrent();
        return result;
      },
      install: async (params, beforePersistentApply) => {
        const commitGuard = () => {
          assertCurrent();
          beforePersistentApply?.();
        };
        commitGuard();
        return await applyTemplateAddForRequest({
          ...options,
          params,
          sessionMutationCommitGuard: commitGuard,
        }).catch((error: unknown) => {
          throw new Error(reportTemplateAddFailure(error, "apply"), { cause: error });
        });
      },
    };
    return await withSystemAgentTemplateGateway(gateway, () => handler(options));
  };
}

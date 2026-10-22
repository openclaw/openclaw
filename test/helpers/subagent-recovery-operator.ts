import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { captureAgentTurnPrincipal } from "../../src/gateway/agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "../../src/gateway/auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "../../src/gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../src/gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../../src/plugins/runtime/gateway-request-scope.js";

/** Persist a real principal and capture its source through ordinary subagent registration. */
export async function withSubagentRecoveryOperator<T>(
  config: OpenClawConfig,
  run: (profileId: string) => Promise<T>,
): Promise<T> {
  const context = createContext();
  context.getRuntimeConfig = () => config;
  context.resolveGatewayContext = () => context;
  const operator = createOperatorClient({
    profileName: "restored-subagent-requester",
    scopes: ["operator.write"],
  });
  operator.internal = { authenticatedOperator: true };
  operator.authPolicy = captureGatewayAuthPolicy(config, {
    role: "operator",
    authMethod: "token",
  });
  const source = expectDefined(
    await captureGatewayOperatorRunAuthority({
      client: expectDefined(captureAgentTurnPrincipal(operator), "requester principal"),
      context,
      // These Gateway fixtures disable plugins; null is their admitted grant basis.
      sourceAuthority: null,
    }),
    "restored requester authority",
  );
  operator.internal.operatorRunAuthority = source.authority;
  try {
    return await withPluginRuntimeGatewayRequestScope(
      {
        client: operator,
        context,
        resolveGatewayContext: context.resolveGatewayContext,
        isWebchatConnect: () => false,
      },
      () => run(source.authority.profileId),
    );
  } finally {
    source.release();
  }
}

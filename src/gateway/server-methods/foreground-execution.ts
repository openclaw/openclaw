import { assertExecutionMayContinue } from "../../agents/run-execution-policy.js";
import { isGatewayToolForegroundOnly } from "../../agents/tools/gateway-caller-context.js";
import { resolveOperatorRolePolicy } from "../operator-role-policy.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  readGatewayRequestMutationAuthority,
} from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Capture before awaits; personal tool selection cannot replace the signed source restriction. */
export function captureForegroundContinuationGuard(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context">,
  activity: string,
): () => void {
  const { client, context } = options;
  const restricted =
    client?.internal?.agentRuntimeIdentity?.execution === "foreground-only" ||
    client?.internal?.operatorRunAuthority?.rolePolicy?.execution === "foreground-only" ||
    isGatewayToolForegroundOnly() ||
    (client !== null &&
      resolveOperatorRolePolicy(client, context.getRuntimeConfig())?.execution ===
        "foreground-only");
  return () => assertExecutionMayContinue(restricted, activity);
}

/** Preserve the identity-bound request authority when adding the continuation fence. */
export function bindForegroundContinuationGuard(
  options: GatewayRequestHandlerOptions,
  activity: string,
): GatewayRequestHandlerOptions {
  const assertMayContinue = captureForegroundContinuationGuard(options, activity);
  assertMayContinue();
  const authority = readGatewayRequestMutationAuthority(options);
  return bindGatewayRequestHandlerMutationAuthority(
    options,
    {
      ...options,
      sessionMutationCommitGuard: () => {
        authority.assertCurrent();
        assertMayContinue();
      },
    },
    undefined,
  );
}

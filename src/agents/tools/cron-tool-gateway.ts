import { attachPluginCommandCreation } from "../../cron/plugin-command-creation.js";
import type { CronStreamExecPolicy } from "../../cron/stream-exec-authority.js";
import { attachCronStreamExecPolicy } from "../../gateway/cron-creator-authority-grant.js";
import type {
  bindCronManagementGrant,
  bindCronRequesterGrant,
} from "../cron-creator-authority-context.js";
import { assertCronStreamExecPolicyWithoutApproval } from "./cron-tool-write.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { callGatewayTool, shouldUseInProcessGatewayTool } from "./gateway.js";

/** Each cron request carries its current creator or management grants. */
export function createCronToolGatewayCaller({
  managementAuthority,
  requesterAuthority,
  operationSignal,
  readStreamExecPolicy,
  onEffectsStart,
  assertCurrent,
}: {
  managementAuthority: ReturnType<typeof bindCronManagementGrant>;
  requesterAuthority: ReturnType<typeof bindCronRequesterGrant>;
  operationSignal?: AbortSignal;
  readStreamExecPolicy: () => CronStreamExecPolicy | undefined;
  onEffectsStart?: () => void;
  assertCurrent?: () => void;
}): typeof callGatewayTool {
  return async <T>(...request: Parameters<typeof callGatewayTool>) => {
    operationSignal?.throwIfAborted();
    assertCurrent?.();
    if (request[0] === "cron.add" || request[0] === "cron.update") {
      onEffectsStart?.();
    }
    const identity = getGatewayToolCallerIdentity();
    const grant = managementAuthority?.mint(request[0], operationSignal);
    const requesterGrant =
      !grant &&
      !identity?.cronCreatorAuthorityGrant &&
      (request[0] === "cron.add" || request[0] === "cron.update")
        ? (requesterAuthority ?? identity?.mintCronRequesterGrant)?.(operationSignal)
        : undefined;
    if ((grant || requesterGrant) && !identity) {
      throw new Error(
        "Automation management requires the active configured channel owner, Control UI administrator, or Android app administrator turn.",
      );
    }
    const streamExecPolicy = readStreamExecPolicy();
    if (streamExecPolicy && (request[0] === "cron.add" || request[0] === "cron.update")) {
      const policyGrant = grant ?? requesterGrant ?? identity?.cronCreatorAuthorityGrant;
      if (policyGrant) {
        attachCronStreamExecPolicy(policyGrant, streamExecPolicy);
      } else {
        await assertCronStreamExecPolicyWithoutApproval(streamExecPolicy);
      }
    }
    operationSignal?.throwIfAborted();
    assertCurrent?.();
    request[2] = attachPluginCommandCreation(
      request[0],
      request[2],
      shouldUseInProcessGatewayTool(request[1]),
    );
    const result =
      (grant || requesterGrant) && identity
        ? await withGatewayToolCallerIdentity(
            {
              ...identity,
              ...(grant ? { cronManagementGrant: grant } : {}),
              ...(requesterGrant ? { cronCreatorAuthorityGrant: requesterGrant } : {}),
            },
            () => callGatewayTool<T>(...request),
          )
        : await callGatewayTool<T>(...request);
    operationSignal?.throwIfAborted();
    assertCurrent?.();
    return result;
  };
}

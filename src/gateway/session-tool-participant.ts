import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayPersonalToolParticipant,
} from "../agents/tools/gateway-caller-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { isSessionTargetMethod } from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

/** Unselected calls can retain the owner only for the shared turn's own session. */
export function resolveRuntimeSessionParticipant(params: {
  method: string;
  requestParams: unknown;
  runtimeIdentity: AgentRuntimeIdentity | undefined;
  context: GatewayRequestContext;
  connId?: string;
}) {
  const caller = getGatewayToolCallerIdentity();
  const { method, runtimeIdentity, context } = params;
  if (caller?.personalToolIdentityScoped || !isSessionTargetMethod(method)) {
    return undefined;
  }
  const turn = caller ?? runtimeIdentity;
  const allowTurnOwner = () => {
    if (!turn) {
      return false;
    }
    try {
      const targets = context.resolveSessionRequestTargets?.({
        method,
        requestParams: params.requestParams,
        connId: params.connId,
      });
      const cfg = context.getRuntimeConfig();
      const own = resolveSessionStoreIdentity({ cfg, ...turn });
      return Boolean(
        targets?.length &&
        targets.every((target) => {
          const resolved = resolveSessionStoreIdentity({ cfg, ...target });
          return resolved.agentId === own.agentId && resolved.canonicalKey === own.canonicalKey;
        }),
      );
    } catch {
      return false;
    }
  };
  const checked = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `${formatErrorMessage(error)} Use a session tool with the requester's requester_profile.id as user.`,
        ),
      );
    }
  };
  const participant = checked(() =>
    resolveGatewayPersonalToolParticipant(runtimeIdentity, {
      requireSingleParticipant: true,
      allowMissingRegistry: true,
      allowTurnOwner,
    }),
  );
  return participant && { assertCurrent: () => checked(participant.assertCurrent) };
}

/** Expected participant refusals are request policy outcomes, not handler failures. */
export function resolveRuntimeSessionParticipantRequest(
  options: Pick<GatewayRequestOptions, "req" | "client" | "respond" | "context">,
): ReturnType<typeof resolveRuntimeSessionParticipant> | null {
  try {
    return resolveRuntimeSessionParticipant({
      method: options.req.method,
      requestParams: options.req.params,
      runtimeIdentity: options.client?.internal?.agentRuntimeIdentity,
      context: options.context,
      connId: options.client?.connId,
    });
  } catch (error) {
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
    );
    return null;
  }
}

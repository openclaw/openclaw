/** The automations tool's `wake` action: target selection and the Gateway request. */
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { jsonResult, readToolStringParam } from "./common.js";
import type { CronToolOptions } from "./cron-tool.types.js";
import type { callGatewayTool, GatewayCallOptions } from "./gateway.js";

type ParentWake = NonNullable<CronToolOptions["parentWake"]>;

/**
 * The parent wake for a scheduled run, or undefined for an ordinary wake. A
 * self-scoped run may wake only its parent; an unscoped run wakes the parent
 * when it names no other target.
 */
function resolveParentWake(
  opts: CronToolOptions | undefined,
  params: Record<string, unknown>,
): ParentWake | undefined {
  const parentWake = opts?.parentWake;
  if (!parentWake) {
    return undefined;
  }
  const explicitSessionKey = readToolStringParam(params, "sessionKey");
  const explicitAgentId = readToolStringParam(params, "agentId");
  const namesOtherTarget =
    (explicitSessionKey !== undefined && explicitSessionKey !== parentWake.sessionKey) ||
    (explicitAgentId !== undefined &&
      explicitAgentId !== parseAgentSessionKey(parentWake.sessionKey)?.agentId);
  if (!namesOtherTarget) {
    return parentWake;
  }
  if (opts?.selfRemoveOnlyJobId?.trim()) {
    throw new Error(
      "A scheduled run can wake only the conversation that created its automation; omit sessionKey and agentId.",
    );
  }
  return undefined;
}

/**
 * Sends one wake. A scheduled run's parent wake checks the parent before the
 * request and again at the handler's commit point, so a reset or removed
 * parent, or a settled occurrence, records nothing. Any other wake targets the
 * explicit session or the calling conversation; the Gateway authorizes it.
 */
export async function executeCronWake(params: {
  opts: CronToolOptions | undefined;
  input: Record<string, unknown>;
  callGateway: typeof callGatewayTool;
  gatewayOpts: GatewayCallOptions;
  callerSessionKey?: string;
  callerAgentId?: string;
}) {
  const { input, callGateway, gatewayOpts } = params;
  const text = readToolStringParam(input, "text", { required: true });
  const mode =
    input.mode === "now" || input.mode === "next-heartbeat" ? input.mode : "next-heartbeat";
  const parentWake = resolveParentWake(params.opts, input);
  if (parentWake) {
    parentWake.assertCurrent();
    return jsonResult(
      await callGateway(
        "wake",
        gatewayOpts,
        { mode, text, sessionKey: parentWake.sessionKey },
        { expectFinal: false, sessionMutationCommitGuard: parentWake.assertCurrent },
      ),
    );
  }
  // An omitted target wakes the originating conversation, not the heartbeat lane.
  const explicitSessionKey = readToolStringParam(input, "sessionKey");
  const explicitAgentId = readToolStringParam(input, "agentId");
  const sessionKey = explicitSessionKey ?? params.callerSessionKey;
  // Pair an explicit session with its own agent; caller defaults must not
  // rewrite that target before the Gateway can validate it.
  const agentId =
    explicitAgentId ??
    (explicitSessionKey ? parseAgentSessionKey(explicitSessionKey)?.agentId : params.callerAgentId);
  return jsonResult(
    await callGateway(
      "wake",
      gatewayOpts,
      { mode, text, ...(sessionKey ? { sessionKey } : {}), ...(agentId ? { agentId } : {}) },
      { expectFinal: false },
    ),
  );
}

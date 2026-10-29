import { createSessionVisibilityRowChecker } from "../../plugin-sdk/session-visibility.js";
import { normalizeAgentIdStrict } from "../../routing/session-key.js";
import { describeAgentIdForName } from "../identity.js";
import { ToolInputError } from "../tool-input-error.js";
import { readNonNegativeIntegerParam, readToolStringParam } from "./common.js";
import type { resolveSessionToolContext } from "./sessions-helpers.js";
import { resolveConfiguredAgentMainSessionKey } from "./sessions-send-tool.delivery.js";

/** Who is sending; an unknown-agent hint only names agents this requester may send to. */
type SendTargetScope = Pick<
  ReturnType<typeof resolveSessionToolContext>,
  | "cfg"
  | "mainKey"
  | "effectiveRequesterKey"
  | "mainSessionKey"
  | "restrictToSpawned"
  | "sessionVisibility"
  | "a2aPolicy"
> & { requesterAgentId: string };

export function formatUnknownAgentError(scope: SendTargetScope, agentId: string | undefined) {
  const { cfg, mainKey, requesterAgentId, restrictToSpawned } = scope;
  // The send-access owner decides, so the hint never names a target the retry would be denied.
  const sendAccess = createSessionVisibilityRowChecker({
    action: "send",
    requesterAgentId,
    requesterSessionKey: scope.effectiveRequesterKey,
    mainSessionKey: scope.mainSessionKey,
    visibility: scope.sessionVisibility,
    a2aPolicy: scope.a2aPolicy,
  });
  const isTarget = (id: string) => {
    const key = resolveConfiguredAgentMainSessionKey({ cfg, agentId: id, mainKey });
    return (
      !restrictToSpawned && key !== undefined && sendAccess.check({ key, agentId: id }).allowed
    );
  };
  const hint = agentId ? describeAgentIdForName(cfg, agentId, isTarget) : undefined;
  return `Agent "${agentId}" not found.${hint ? ` ${hint}` : ""} Run openclaw agents list to see configured agents.`;
}

export function readSessionsSendTarget(params: Record<string, unknown>, scope: SendTargetScope) {
  const sessionKeyParam = readToolStringParam(params, "sessionKey");
  const labelParam = readToolStringParam(params, "label");
  const labelAgentIdInput = readToolStringParam(params, "agentId");
  const normalizedLabelAgentId =
    labelAgentIdInput === undefined ? null : normalizeAgentIdStrict(labelAgentIdInput);
  if (normalizedLabelAgentId && !normalizedLabelAgentId.ok) {
    return { ok: false as const, error: formatUnknownAgentError(scope, labelAgentIdInput) };
  }
  return {
    ok: true as const,
    sessionKeyParam,
    labelParam,
    labelAgentIdInput,
    explicitTargetAgentId: normalizedLabelAgentId?.value,
  };
}

export function readSessionsSendMessage(params: Record<string, unknown>): string {
  const message = readToolStringParam(params, "message", { required: true, trim: false });
  if (!message.trim()) {
    throw new ToolInputError("message required");
  }
  return message;
}

export function readSessionsSendTimeout(
  params: Record<string, unknown>,
  mode: ReturnType<typeof readSessionsSendMode>,
): number {
  if (
    mode === "resume" &&
    (params.watch === true || (readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 0) > 0)
  ) {
    throw new ToolInputError(
      "mode=resume returns admission only; omit watch and timeoutSeconds or set timeoutSeconds=0. The task owner delivers completion.",
    );
  }
  return mode === "steer" || mode === "resume"
    ? 0
    : (readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30);
}

export function readSessionsSendMode(params: Record<string, unknown>) {
  const mode = readToolStringParam(params, "mode");
  if (
    mode !== undefined &&
    mode !== "notify" &&
    mode !== "steer" &&
    mode !== "followup" &&
    mode !== "resume"
  ) {
    throw new ToolInputError("mode must be notify, steer, followup, or resume");
  }
  return mode;
}

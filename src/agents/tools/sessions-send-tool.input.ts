import { normalizeAgentIdStrict } from "../../routing/session-key.js";
import { ToolInputError } from "../tool-input-error.js";
import { readNonNegativeIntegerParam, readToolStringParam } from "./common.js";

export function readSessionsSendTarget(params: Record<string, unknown>) {
  const sessionKeyParam = readToolStringParam(params, "sessionKey");
  const labelParam = readToolStringParam(params, "label");
  const labelAgentIdInput = readToolStringParam(params, "agentId");
  const normalizedLabelAgentId =
    labelAgentIdInput === undefined ? null : normalizeAgentIdStrict(labelAgentIdInput);
  if (normalizedLabelAgentId && !normalizedLabelAgentId.ok) {
    return {
      ok: false as const,
      error: `Agent "${labelAgentIdInput}" not found. Run openclaw agents list to see configured agents.`,
    };
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
  // The message tool already accepts text as an alias; keep the two tools consistent.
  const message = readToolStringParam(params, "message", { trim: false });
  const alias = readToolStringParam(params, "text", { trim: false });
  const resolved = message?.trim() ? message : alias;
  if (!resolved || !resolved.trim()) {
    throw new ToolInputError("message required");
  }
  return resolved;
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

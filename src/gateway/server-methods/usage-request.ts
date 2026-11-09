import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { respondError } from "./response.js";
import type { RespondFn } from "./types.js";
import {
  resolveDateInterpretation,
  resolveDateRange,
  type DateInterpretation,
  type DateRange,
} from "./usage-date-range.js";
import { resolveSessionUsageTarget } from "./usage-session-selection.js";

export async function resolveSessionUsageFileOrRespond(
  params: { key?: unknown; agentId?: unknown } | undefined,
  detail: "timeseries" | "logs",
  respond: RespondFn,
  config: OpenClawConfig,
) {
  const key = normalizeOptionalString(params?.key);
  if (!key) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, `key is required for ${detail}`);
    return null;
  }
  const sessionOwner = resolveRequestedSessionAgentId(
    config,
    key,
    normalizeOptionalString(params?.agentId),
  );
  if (!sessionOwner.ok) {
    respond(false, undefined, sessionOwner.error);
    return null;
  }
  let resolved: Awaited<ReturnType<typeof resolveSessionUsageTarget>>;
  try {
    resolved = await resolveSessionUsageTarget(key, config, sessionOwner.agentId);
  } catch {
    getAsyncWorkSignal()?.throwIfAborted();
    resolved = undefined;
  }
  if (!resolved) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, `Invalid session key: ${key}`);
    return null;
  }
  return { config, key, ...resolved };
}

export function resolveUsageDateRangeOrRespond(
  params: Parameters<typeof resolveDateRange>[0],
  respond: RespondFn,
): { interpretation: DateInterpretation; range: DateRange } | null {
  const interpretation = resolveDateInterpretation(params);
  if (!interpretation.ok) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, interpretation.error);
    return null;
  }

  const range = resolveDateRange(params, interpretation.value);
  if (!range.ok) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, range.error);
    return null;
  }
  return { interpretation: interpretation.value, range: range.value };
}

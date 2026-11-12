import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { isGatewayAdmin } from "../session-sharing.js";
import { respondError } from "./response.js";
import type { RespondFn } from "./types.js";
import {
  resolveDateInterpretation,
  resolveDateRange,
  resolveDayBucket,
  type DateInterpretation,
  type DateRange,
} from "./usage-date-range.js";
import { loadCostUsageSummaryCached } from "./usage-result-cache.js";
import { withUsageRequestBudget } from "./usage-session-loading.js";
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

export const usageCostHandler = withUsageRequestBudget(
  async ({ respond, params, context, client }, budget) => {
    const dateRange = resolveUsageDateRangeOrRespond(params ?? {}, respond);
    if (!dateRange) {
      return;
    }
    const { interpretation: dateInterpretation, range } = dateRange;
    const config = context.getRuntimeConfig();
    if (
      !isGatewayAdmin(client ?? null) &&
      ["none", "invited"].includes(operatorSessionCap(client ?? null, config) ?? "")
    ) {
      respondError(
        respond,
        ErrorCodes.FORBIDDEN,
        "Aggregate usage includes sessions hidden by your operator role; ask an administrator to review Gateway-wide usage.",
      );
      return;
    }
    const { startMs, endMs } = range;
    const requestedAgentId = params?.agentId;
    const requestedAgentScope = params?.agentScope;
    if (requestedAgentId !== undefined && typeof requestedAgentId !== "string") {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "agentId must be a string");
      return;
    }
    if (requestedAgentScope !== undefined && requestedAgentScope !== "all") {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "agentScope must be 'all' when provided");
      return;
    }
    const agentId = normalizeOptionalString(requestedAgentId);
    if (requestedAgentScope === "all" && agentId) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "agentScope=all cannot be combined with agentId",
      );
      return;
    }
    const agentScope = requestedAgentScope === "all" ? "all" : undefined;
    let effectiveAgentId = agentId;
    if (!agentScope && !effectiveAgentId) {
      const requestedAgent = resolveRequestedSessionAgentId(config, "main");
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      effectiveAgentId = requestedAgent.agentId;
    }
    const summary = await budget.read(
      () =>
        loadCostUsageSummaryCached({
          startMs,
          endMs,
          dayBucket: resolveDayBucket(dateInterpretation),
          config,
          agentId: effectiveAgentId,
          agentScope,
        }),
      () => undefined,
    );
    if (!summary) {
      respondError(respond, ErrorCodes.UNAVAILABLE, budget.hint);
      return;
    }
    respond(true, summary, undefined);
  },
  { cancelOnReply: true },
);

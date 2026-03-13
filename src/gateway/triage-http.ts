import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createIdentityLookupFromEnv } from "../domain/identity/lookup.js";
import type { Channel, SubjectCandidate } from "../domain/identity/stateMachine.js";
import {
  createAppFolioExecuteAdapterFromEnv,
  type AppFolioExecuteAdapter,
} from "./appfolio-adapter.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendInvalidRequest, sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { getHeader } from "./http-utils.js";
import { executeLane, type LaneExecutorDeps } from "./lane-executors.js";
import { composeTriageResponse } from "./response-compose.js";
import {
  selectLaneFromScores,
  type TriagePolicyDecision,
  type TriageRequestContext,
} from "./triage-router.js";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_TRIAGE_VERSION = "triage-v1";
const DEFAULT_POLICY_VERSION = "gateway-policy-v1";

type TriageHttpBody = {
  requestId?: unknown;
  message?: unknown;
  channel?: unknown;
  channelIdentity?: unknown;
  intentSlug?: unknown;
  actionType?: unknown;
  idResolution?: unknown;
  executionHint?: unknown;
  isFinancial?: unknown;
  isEmergency?: unknown;
  hasRequiredEntities?: unknown;
  confidence?: unknown;
  entities?: unknown;
  args?: unknown;
};

type TriageHttpOpts = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  laneDeps?: LaneExecutorDeps;
  identityLookup?: ReturnType<typeof createIdentityLookupFromEnv>;
  appFolioExecuteAdapter?: AppFolioExecuteAdapter;
};

const defaultIdentityLookup = createIdentityLookupFromEnv();
const defaultAppFolioExecuteAdapter = createAppFolioExecuteAdapterFromEnv();

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDecision(params: {
  isFinancial: boolean;
  req: IncomingMessage;
  identityCandidateCount: number;
}): { decision: TriagePolicyDecision; reason?: string } {
  const forced = getHeader(params.req, "x-openclaw-policy-decision")?.trim().toLowerCase();
  if (forced === "deny" || forced === "ask_clarification" || forced === "stepup") {
    return {
      decision: forced,
      reason: getHeader(params.req, "x-openclaw-policy-reason")?.trim() || "policy_override",
    };
  }

  if (params.isFinancial) {
    if (params.identityCandidateCount === 0) {
      return {
        decision: "stepup",
        reason: "financial_identity_resolution_required",
      };
    }
    const verified = parseBool(getHeader(params.req, "x-openclaw-verified"), false);
    if (!verified) {
      return {
        decision: "stepup",
        reason: "financial_verification_required",
      };
    }
  }
  return { decision: "allow" };
}

function resolveLookupChannel(value: string): Channel {
  if (value === "sms" || value === "email" || value === "voice" || value === "telegram") {
    return value;
  }
  return "email";
}

function resolveIdentityConfidence(candidates: SubjectCandidate[]): number {
  if (candidates.length === 0) {
    return 0.35;
  }
  const rank = { high: 0.95, medium: 0.75, low: 0.55 } as const;
  const best = Math.max(
    ...candidates.map((candidate) => rank[candidate.identityConfidence] ?? 0.35),
  );
  return Number.isFinite(best) ? best : 0.35;
}

function resolveIdentityScopedUnitId(
  candidates: SubjectCandidate[],
  explicitUnitId?: string,
): string | undefined {
  if (explicitUnitId?.trim()) {
    return explicitUnitId.trim();
  }
  const allowedUnits = Array.from(
    new Set(
      candidates
        .flatMap((candidate) => candidate.allowedUnitIds)
        .map((unitId) => unitId.trim())
        .filter(Boolean),
    ),
  );
  return allowedUnits.length === 1 ? allowedUnits[0] : undefined;
}

function fallbackTextForDecision(decision: Exclude<TriagePolicyDecision, "allow">): string {
  if (decision === "ask_clarification") {
    return "Please clarify the unit or account details so I can continue.";
  }
  if (decision === "stepup") {
    return "Additional verification is required before I can continue.";
  }
  return "Your request cannot be completed in this channel.";
}

export async function handleTriageHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: TriageHttpOpts,
): Promise<boolean> {
  const endpoint = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/api/triage",
    auth: opts.auth,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (endpoint === false) {
    return false;
  }
  if (!endpoint) {
    return true;
  }

  const body = asRecord(endpoint.body) as TriageHttpBody;
  const messageText = typeof body.message === "string" ? body.message.trim() : "";
  if (!messageText) {
    sendInvalidRequest(res, "triage requires body.message");
    return true;
  }

  const requestId = (typeof body.requestId === "string" && body.requestId.trim()) || randomUUID();
  const channel =
    typeof body.channel === "string" && body.channel.trim() ? body.channel.trim() : "email";
  const channelIdentity =
    (typeof body.channelIdentity === "string" && body.channelIdentity.trim()) || "unknown";
  const intentSlug =
    (typeof body.intentSlug === "string" && body.intentSlug.trim()) ||
    getHeader(req, "x-openclaw-intent-slug")?.trim() ||
    "hook_message";
  const actionTypeRaw =
    (typeof body.actionType === "string" && body.actionType.trim()) ||
    getHeader(req, "x-openclaw-action-type")?.trim() ||
    "read";
  const actionType: "read" | "write" | "notify" =
    actionTypeRaw === "write" || actionTypeRaw === "notify" ? actionTypeRaw : "read";
  const executionHintRaw =
    (typeof body.executionHint === "string" && body.executionHint.trim()) ||
    getHeader(req, "x-openclaw-execution-mode")?.trim() ||
    "api+light-llm";
  const executionHint: "api-first" | "api+light-llm" | "heavy-llm" =
    executionHintRaw === "api-first" ||
    executionHintRaw === "api+light-llm" ||
    executionHintRaw === "heavy-llm"
      ? executionHintRaw
      : "api+light-llm";

  const isFinancial = parseBool(
    body.isFinancial,
    parseBool(getHeader(req, "x-openclaw-is-financial"), false),
  );
  const hasRequiredEntities = parseBool(body.hasRequiredEntities, false);
  const isEmergency = parseBool(body.isEmergency, false);
  const confidence = asRecord(body.confidence);
  const entities = asRecord(body.entities);
  const args = asRecord(body.args);
  const unitId = typeof entities.unitId === "string" ? entities.unitId : undefined;
  const propertyId = typeof entities.propertyId === "string" ? entities.propertyId : undefined;

  const identityLookup = opts.identityLookup ?? defaultIdentityLookup;
  const identityCandidates = await identityLookup({
    channel: resolveLookupChannel(channel),
    channelIdentity,
    intentSlug,
  });
  const resolvedUnitId = resolveIdentityScopedUnitId(identityCandidates, unitId);
  const resolvedHasRequiredEntities = hasRequiredEntities || Boolean(resolvedUnitId);
  const identityConfidenceFromLookup = resolveIdentityConfidence(identityCandidates);

  const policy = parseDecision({
    isFinancial,
    req,
    identityCandidateCount: identityCandidates.length,
  });
  const startedAt = Date.now();

  if (policy.decision !== "allow") {
    const emptyScores = [
      {
        lane: "api_only" as const,
        score: 0,
        features: {
          confidence: 0,
          policyFit: 0,
          latencyFit: 0,
          dataAvailability: 0,
          penalty: 0,
        },
      },
      {
        lane: "low_llm" as const,
        score: 0,
        features: {
          confidence: 0,
          policyFit: 0,
          latencyFit: 0,
          dataAvailability: 0,
          penalty: 0,
        },
      },
      {
        lane: "high_llm" as const,
        score: 0,
        features: {
          confidence: 0,
          policyFit: 0,
          latencyFit: 0,
          dataAvailability: 0,
          penalty: 0,
        },
      },
    ];

    const response = composeTriageResponse({
      ok: policy.decision !== "deny",
      requestId,
      decision: policy.decision,
      lane: "api_only",
      laneScores: emptyScores,
      result: {
        lane: "api_only",
        status: policy.decision === "ask_clarification" ? "clarify" : policy.decision,
        answerText: fallbackTextForDecision(policy.decision),
        evidence: [],
        usage: { apiCalls: 0, llmCalls: 0 },
        escalation:
          policy.decision === "stepup"
            ? { required: true, reason: policy.reason || "stepup_required" }
            : { required: false },
      },
      riskScore: isFinancial ? 80 : 30,
      latencyMs: Date.now() - startedAt,
      audit: {
        policyVersion: DEFAULT_POLICY_VERSION,
        triageVersion: DEFAULT_TRIAGE_VERSION,
        traceId: randomUUID(),
      },
    });
    sendJson(
      res,
      policy.decision === "deny" ? 403 : policy.decision === "stepup" ? 401 : 200,
      response,
    );
    return true;
  }

  const triageContext: TriageRequestContext = {
    intentSlug,
    actionType,
    executionHint,
    isFinancial,
    isEmergency,
    hasRequiredEntities: resolvedHasRequiredEntities,
    identityConfidence: parseNumber(confidence.identity, identityConfidenceFromLookup),
    intentConfidence: parseNumber(confidence.intent, 0.75),
    entityConfidence: parseNumber(confidence.entity, resolvedHasRequiredEntities ? 0.9 : 0.45),
    estimatedLatencyMs: {
      apiOnly: parseNumber((body as Record<string, unknown>).estimatedApiLatencyMs, 400),
      lowLlm: parseNumber((body as Record<string, unknown>).estimatedLowLlmLatencyMs, 1300),
      highLlm: parseNumber((body as Record<string, unknown>).estimatedHighLlmLatencyMs, 2600),
    },
    dataAvailability: {
      apiOnly: parseNumber(
        (body as Record<string, unknown>).apiDataAvailability,
        resolvedHasRequiredEntities ? 0.9 : 0.4,
      ),
      lowLlm: parseNumber((body as Record<string, unknown>).lowLlmDataAvailability, 0.8),
      highLlm: parseNumber((body as Record<string, unknown>).highLlmDataAvailability, 0.75),
    },
  };

  const selection = selectLaneFromScores({
    policyDecision: "allow",
    request: triageContext,
    latencyBudgetMs: channel === "sms" ? 2500 : channel === "voice" ? 1500 : 6000,
  });

  const laneDeps: LaneExecutorDeps = {
    executeApiIntent:
      opts.laneDeps?.executeApiIntent ??
      opts.appFolioExecuteAdapter ??
      defaultAppFolioExecuteAdapter,
    runLowLlm: opts.laneDeps?.runLowLlm,
    runHighLlm: opts.laneDeps?.runHighLlm,
  };

  let result = await executeLane(
    {
      requestId,
      lane: selection.selectedLane,
      messageText,
      intentSlug,
      unitId: resolvedUnitId,
      propertyId,
      args,
    },
    laneDeps,
  );

  if (result.status === "error" && result.retriable && result.lane === "api_only") {
    result = await executeLane(
      {
        requestId,
        lane: "low_llm",
        messageText,
        intentSlug,
        unitId: resolvedUnitId,
        propertyId,
        args,
      },
      laneDeps,
    );
  }

  const response = composeTriageResponse({
    ok: result.status !== "error" && result.status !== "deny",
    requestId,
    decision: "allow",
    lane: result.lane,
    laneScores: selection.scores,
    result,
    riskScore: isFinancial ? 70 : 30,
    latencyMs: Date.now() - startedAt,
    audit: {
      policyVersion: DEFAULT_POLICY_VERSION,
      triageVersion: DEFAULT_TRIAGE_VERSION,
      traceId: randomUUID(),
    },
  });

  const statusCode = result.status === "error" ? 502 : 200;
  sendJson(res, statusCode, response);
  return true;
}

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveContextEngine } from "../context-engine/registry.js";
import type {
  ContextEngineControlCapabilities,
  ContextEngineControlOperation,
  ContextEngineControlResult,
} from "../context-engine/types.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  isValidAgentId,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";

const DEFAULT_ROTATE_RATE_LIMIT_MS = 60_000;
const CONTROL_OPERATIONS = new Set<ContextEngineControlOperation>(["status", "doctor", "rotate"]);

type ContextEngineControlErrorType =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "capability_unavailable"
  | "rate_limited"
  | "unavailable"
  | "degraded";

type ContextEngineControlErrorStatus = 400 | 403 | 404 | 429 | 501 | 503;
type ContextEngineCapabilitiesErrorStatus = 400 | 404 | 503;

export type ContextEngineControlInput = {
  agentId?: unknown;
  operation?: unknown;
  sessionKey?: unknown;
};

export type ContextEngineControlOutcome =
  | {
      ok: true;
      status: 200;
      result: ContextEngineControlResult;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 429 | 501 | 503;
      error: {
        type: ContextEngineControlErrorType;
        message: string;
        retryAfterMs?: number;
      };
    };

export type ContextEngineCapabilitiesOutcome =
  | {
      ok: true;
      status: 200;
      result: {
        agentId: string;
        engineId: string;
        capabilities: ContextEngineControlCapabilities;
      };
    }
  | {
      ok: false;
      status: 400 | 404 | 503;
      error: {
        type: ContextEngineControlErrorType;
        message: string;
      };
    };

const rotateRateLimitState = new Map<string, number>();

export function resetContextEngineControlRateLimitsForTest(): void {
  rotateRateLimitState.clear();
}

function emptyCapabilities(): ContextEngineControlCapabilities {
  return { status: false, doctor: false, rotate: false };
}

function normalizeCapabilities(value: unknown): ContextEngineControlCapabilities {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    status: record.status === true,
    doctor: record.doctor === true,
    rotate: record.rotate === true,
  };
}

function errorOutcome(
  status: ContextEngineControlErrorStatus,
  type: ContextEngineControlErrorType,
  message: string,
  retryAfterMs?: number,
): ContextEngineControlOutcome {
  return {
    ok: false,
    status,
    error: {
      type,
      message,
      ...(retryAfterMs ? { retryAfterMs } : {}),
    },
  };
}

function capabilitiesErrorOutcome(
  status: ContextEngineCapabilitiesErrorStatus,
  type: ContextEngineControlErrorType,
  message: string,
): ContextEngineCapabilitiesOutcome {
  return { ok: false, status, error: { type, message } };
}

export function resolveContextEngineControlOperation(
  value: unknown,
): ContextEngineControlOperation | undefined {
  const operation = normalizeOptionalString(value);
  return operation && CONTROL_OPERATIONS.has(operation as ContextEngineControlOperation)
    ? (operation as ContextEngineControlOperation)
    : undefined;
}

function resolveKnownAgentId(cfg: OpenClawConfig, value: unknown) {
  const raw = normalizeOptionalString(value);
  if (!raw || !isValidAgentId(raw)) {
    return {
      ok: false as const,
      status: 400 as const,
      message: "context-engine control requires a valid agentId",
    };
  }
  const agentId = normalizeAgentId(raw);
  if (!listAgentIds(cfg).includes(agentId)) {
    return { ok: false as const, status: 404 as const, message: "Unknown agent" };
  }
  return { ok: true as const, agentId };
}

function validateSessionKeyForAgent(params: { agentId: string; sessionKey: unknown }) {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return {
      ok: false as const,
      status: 400 as const,
      type: "invalid_request" as const,
      message: "context-engine control requires sessionKey",
    };
  }

  const lowered = sessionKey.toLowerCase();
  if (
    lowered.startsWith("subagent:") ||
    lowered.startsWith("cron:") ||
    lowered.startsWith("acp:") ||
    isSubagentSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey)
  ) {
    return {
      ok: false as const,
      status: 403 as const,
      type: "forbidden" as const,
      message: "Reserved session namespaces cannot be controlled through this endpoint",
    };
  }

  if (lowered.startsWith("agent:")) {
    const parsed = parseAgentSessionKey(sessionKey);
    if (!parsed) {
      return {
        ok: false as const,
        status: 400 as const,
        type: "invalid_request" as const,
        message: "Malformed agent sessionKey",
      };
    }
    if (normalizeAgentId(parsed.agentId) !== params.agentId) {
      return {
        ok: false as const,
        status: 403 as const,
        type: "forbidden" as const,
        message: "sessionKey does not belong to the requested agent",
      };
    }
  }

  return { ok: true as const, sessionKey };
}

async function resolveSelectedContextEngine(cfg: OpenClawConfig, agentId: string) {
  return resolveContextEngine(cfg, {
    agentDir: resolveAgentDir(cfg, agentId),
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  });
}

function sanitizeControlResult(
  result: unknown,
  operation: ContextEngineControlOperation,
): ContextEngineControlResult | undefined {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (operation === "status") {
    return {
      operation: "status",
      active: record.active === true,
      messageCount:
        Number.isFinite(Number(record.messageCount)) && Number(record.messageCount) > 0
          ? Math.floor(Number(record.messageCount))
          : 0,
    };
  }
  if (operation === "doctor") {
    const warnings = Array.isArray(record.warnings)
      ? record.warnings
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 20)
      : [];
    return {
      operation: "doctor",
      ok: record.ok === true && warnings.length === 0,
      warnings,
    };
  }
  if (operation === "rotate") {
    const lastRotatedAt =
      typeof record.lastRotatedAt === "string" ? record.lastRotatedAt.trim() : "";
    if (!lastRotatedAt) {
      return undefined;
    }
    return {
      operation: "rotate",
      messageCount:
        Number.isFinite(Number(record.messageCount)) && Number(record.messageCount) > 0
          ? Math.floor(Number(record.messageCount))
          : 0,
      lastRotatedAt,
    };
  }
  return undefined;
}

function checkRotateBudget(params: {
  agentId: string;
  sessionKey: string;
  now: number;
  windowMs: number;
}): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const key = `${params.agentId}\0${params.sessionKey}`;
  const previous = rotateRateLimitState.get(key);
  if (previous !== undefined && params.now - previous < params.windowMs) {
    return { allowed: false, retryAfterMs: params.windowMs - (params.now - previous) };
  }
  return { allowed: true };
}

function recordRotateCall(params: { agentId: string; sessionKey: string; now: number }): void {
  rotateRateLimitState.set(`${params.agentId}\0${params.sessionKey}`, params.now);
}

function classifyControlFailure(error: unknown): {
  type: ContextEngineControlErrorType;
  message: string;
} {
  const rawName =
    typeof error === "object" && error !== null && "name" in error
      ? (error as { name?: unknown }).name
      : undefined;
  const name = typeof rawName === "string" ? rawName : "";
  const reasonCode =
    typeof error === "object" && error !== null && "reasonCode" in error
      ? normalizeOptionalString((error as { reasonCode?: unknown }).reasonCode)
      : undefined;
  if (name.includes("Unavailable")) {
    return {
      type: "unavailable",
      message: reasonCode
        ? `Context engine control operation is unavailable (${reasonCode})`
        : "Context engine control operation is unavailable",
    };
  }
  return {
    type: "degraded",
    message: "Context engine control operation failed",
  };
}

function resolveControlSessionId(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string | undefined {
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    });
    const store = loadSessionStore(storePath);
    return normalizeOptionalString(store[params.sessionKey]?.sessionId);
  } catch {
    return undefined;
  }
}

export async function getContextEngineControlCapabilities(params: {
  cfg: OpenClawConfig;
  agentId: unknown;
}): Promise<ContextEngineCapabilitiesOutcome> {
  const agent = resolveKnownAgentId(params.cfg, params.agentId);
  if (!agent.ok) {
    return capabilitiesErrorOutcome(
      agent.status,
      agent.status === 404 ? "not_found" : "invalid_request",
      agent.message,
    );
  }

  try {
    const engine = await resolveSelectedContextEngine(params.cfg, agent.agentId);
    const capabilities = engine.getControlCapabilities
      ? normalizeCapabilities(await engine.getControlCapabilities())
      : emptyCapabilities();
    return {
      ok: true,
      status: 200,
      result: {
        agentId: agent.agentId,
        engineId: engine.info.id,
        capabilities,
      },
    };
  } catch {
    return capabilitiesErrorOutcome(503, "degraded", "Context engine capabilities are unavailable");
  }
}

export async function invokeContextEngineControl(params: {
  cfg: OpenClawConfig;
  input: ContextEngineControlInput;
  now?: number;
  rotateRateLimitMs?: number;
}): Promise<ContextEngineControlOutcome> {
  const agent = resolveKnownAgentId(params.cfg, params.input.agentId);
  if (!agent.ok) {
    return errorOutcome(
      agent.status,
      agent.status === 404 ? "not_found" : "invalid_request",
      agent.message,
    );
  }

  const operation = resolveContextEngineControlOperation(params.input.operation);
  if (!operation) {
    return errorOutcome(400, "invalid_request", "context-engine control requires operation");
  }

  const session = validateSessionKeyForAgent({
    agentId: agent.agentId,
    sessionKey: params.input.sessionKey,
  });
  if (!session.ok) {
    return errorOutcome(session.status, session.type, session.message);
  }

  let engine: Awaited<ReturnType<typeof resolveSelectedContextEngine>>;
  try {
    engine = await resolveSelectedContextEngine(params.cfg, agent.agentId);
  } catch {
    return errorOutcome(503, "degraded", "Context engine control is unavailable");
  }

  const capabilities = engine.getControlCapabilities
    ? normalizeCapabilities(await engine.getControlCapabilities())
    : emptyCapabilities();
  if (!capabilities[operation] || !engine.control) {
    return errorOutcome(
      501,
      "capability_unavailable",
      "Context engine control operation is unavailable",
    );
  }

  const now = params.now ?? Date.now();
  if (operation === "rotate") {
    const budget = checkRotateBudget({
      agentId: agent.agentId,
      sessionKey: session.sessionKey,
      now,
      windowMs: params.rotateRateLimitMs ?? DEFAULT_ROTATE_RATE_LIMIT_MS,
    });
    if (!budget.allowed) {
      return errorOutcome(
        429,
        "rate_limited",
        "Context engine rotate was called too recently",
        budget.retryAfterMs,
      );
    }
  }

  try {
    const sessionId = resolveControlSessionId({
      cfg: params.cfg,
      agentId: agent.agentId,
      sessionKey: session.sessionKey,
    });
    const rawResult = await engine.control({
      agentId: agent.agentId,
      operation,
      ...(sessionId ? { sessionId } : {}),
      sessionKey: session.sessionKey,
    });
    const result = sanitizeControlResult(rawResult, operation);
    if (!result) {
      return errorOutcome(
        503,
        "degraded",
        "Context engine control operation returned an invalid result",
      );
    }
    if (operation === "rotate") {
      recordRotateCall({
        agentId: agent.agentId,
        sessionKey: session.sessionKey,
        now,
      });
    }
    return { ok: true, status: 200, result };
  } catch (error) {
    const failure = classifyControlFailure(error);
    return errorOutcome(503, failure.type, failure.message);
  }
}

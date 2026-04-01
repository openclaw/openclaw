import { sanitizeAgentId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import {
  TimeoutSecondsFieldSchema,
  TrimmedNonEmptyStringFieldSchema,
  parseDeliveryInput,
  parseOptionalField,
} from "./delivery-field-schemas.js";
import { parseAbsoluteTimeMs } from "./parse.js";
import { inferLegacyName } from "./service/normalize.js";
import { normalizeCronStaggerMs, resolveDefaultCronStaggerMs } from "./stagger.js";
import type { CronJobCreate, CronJobPatch } from "./types.js";

type UnknownRecord = Record<string, unknown>;

type NormalizeOptions = {
  applyDefaults?: boolean;
  /** Session context for resolving "current" sessionTarget or auto-binding when not specified */
  sessionContext?: { sessionKey?: string };
};

const DEFAULT_OPTIONS: NormalizeOptions = {
  applyDefaults: false,
};

function coerceSchedule(schedule: UnknownRecord) {
  const next: UnknownRecord = { ...schedule };
  const rawKind = typeof schedule.kind === "string" ? schedule.kind.trim().toLowerCase() : "";
  const kind = rawKind === "at" || rawKind === "every" || rawKind === "cron" ? rawKind : undefined;
  const exprRaw = typeof schedule.expr === "string" ? schedule.expr.trim() : "";
  const legacyCronRaw = typeof schedule.cron === "string" ? schedule.cron.trim() : "";
  const normalizedExpr = exprRaw || legacyCronRaw;
  const atMsRaw = schedule.atMs;
  const atRaw = schedule.at;
  const atString = typeof atRaw === "string" ? atRaw.trim() : "";
  const parsedAtMs =
    typeof atMsRaw === "number"
      ? atMsRaw
      : typeof atMsRaw === "string"
        ? parseAbsoluteTimeMs(atMsRaw)
        : atString
          ? parseAbsoluteTimeMs(atString)
          : null;

  if (kind) {
    next.kind = kind;
  } else {
    if (
      typeof schedule.atMs === "number" ||
      typeof schedule.at === "string" ||
      typeof schedule.atMs === "string"
    ) {
      next.kind = "at";
    } else if (typeof schedule.everyMs === "number") {
      next.kind = "every";
    } else if (normalizedExpr) {
      next.kind = "cron";
    }
  }

  if (atString) {
    next.at = parsedAtMs !== null ? new Date(parsedAtMs).toISOString() : atString;
  } else if (parsedAtMs !== null) {
    next.at = new Date(parsedAtMs).toISOString();
  }
  if ("atMs" in next) {
    delete next.atMs;
  }

  if (normalizedExpr) {
    next.expr = normalizedExpr;
  } else if ("expr" in next) {
    delete next.expr;
  }
  if ("cron" in next) {
    delete next.cron;
  }

  const staggerMs = normalizeCronStaggerMs(schedule.staggerMs);
  if (staggerMs !== undefined) {
    next.staggerMs = staggerMs;
  } else if ("staggerMs" in next) {
    delete next.staggerMs;
  }

  return next;
}

function coercePayload(payload: UnknownRecord) {
  const next: UnknownRecord = { ...payload };
  const kindRaw = typeof next.kind === "string" ? next.kind.trim().toLowerCase() : "";
  if (kindRaw === "agentturn") {
    next.kind = "agentTurn";
  } else if (kindRaw === "systemevent") {
    next.kind = "systemEvent";
  } else if (kindRaw) {
    next.kind = kindRaw;
  }
  if (!next.kind) {
    const hasMessage = typeof next.message === "string" && next.message.trim().length > 0;
    const hasText = typeof next.text === "string" && next.text.trim().length > 0;
    const hasAgentTurnHint =
      typeof next.model === "string" ||
      typeof next.thinking === "string" ||
      typeof next.timeoutSeconds === "number" ||
      typeof next.allowUnsafeExternalContent === "boolean";
    if (hasMessage) {
      next.kind = "agentTurn";
    } else if (hasText) {
      next.kind = "systemEvent";
    } else if (hasAgentTurnHint) {
      // Accept partial agentTurn payload patches that only tweak agent-turn-only fields.
      next.kind = "agentTurn";
    }
  }
  if (typeof next.message === "string") {
    const trimmed = next.message.trim();
    if (trimmed) {
      next.message = trimmed;
    }
  }
  if (typeof next.text === "string") {
    const trimmed = next.text.trim();
    if (trimmed) {
      next.text = trimmed;
    }
  }
  if ("model" in next) {
    const model = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.model);
    if (model !== undefined) {
      next.model = model;
    } else {
      delete next.model;
    }
  }
  if ("thinking" in next) {
    const thinking = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.thinking);
    if (thinking !== undefined) {
      next.thinking = thinking;
    } else {
      delete next.thinking;
    }
  }
  if ("timeoutSeconds" in next) {
    const timeoutSeconds = parseOptionalField(TimeoutSecondsFieldSchema, next.timeoutSeconds);
    if (timeoutSeconds !== undefined) {
      next.timeoutSeconds = timeoutSeconds;
    } else {
      delete next.timeoutSeconds;
    }
  }
  if (
    "allowUnsafeExternalContent" in next &&
    typeof next.allowUnsafeExternalContent !== "boolean"
  ) {
    delete next.allowUnsafeExternalContent;
  }
  if ("toolsAllow" in next) {
    if (Array.isArray(next.toolsAllow)) {
      next.toolsAllow = (next.toolsAllow as unknown[])
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim());
      if ((next.toolsAllow as string[]).length === 0) {
        delete next.toolsAllow;
      }
    } else if (next.toolsAllow === null) {
      // Explicit null means "clear the allow-list" (edit --clear-tools)
      next.toolsAllow = null;
    } else {
      delete next.toolsAllow;
    }
  }
  if ("deliver" in next) {
    delete next.deliver;
  }
  if ("channel" in next) {
    delete next.channel;
  }
  if ("to" in next) {
    delete next.to;
  }
  if ("threadId" in next) {
    delete next.threadId;
  }
  if ("bestEffortDeliver" in next) {
    delete next.bestEffortDeliver;
  }
  if ("provider" in next) {
    delete next.provider;
  }
  return next;
}

function coerceDelivery(delivery: UnknownRecord) {
  const next: UnknownRecord = { ...delivery };
  const parsed = parseDeliveryInput(delivery);
  if (parsed.mode !== undefined) {
    next.mode = parsed.mode;
  } else if ("mode" in next) {
    delete next.mode;
  }
  if (parsed.channel !== undefined) {
    next.channel = parsed.channel;
  } else if ("channel" in next) {
    delete next.channel;
  }
  if (parsed.to !== undefined) {
    next.to = parsed.to;
  } else if ("to" in next) {
    delete next.to;
  }
  if (parsed.threadId !== undefined) {
    next.threadId = parsed.threadId;
  } else if ("threadId" in next) {
    delete next.threadId;
  }
  if (parsed.accountId !== undefined) {
    next.accountId = parsed.accountId;
  } else if ("accountId" in next) {
    delete next.accountId;
  }
  return next;
}

function unwrapJob(raw: UnknownRecord) {
  if (isRecord(raw.data)) {
    return raw.data;
  }
  if (isRecord(raw.job)) {
    return raw.job;
  }
  return raw;
}

function normalizeSessionTarget(raw: unknown) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "main" || lower === "isolated" || lower === "current") {
    return lower;
  }
  // Support custom session IDs with "session:" prefix
  if (lower.startsWith("session:")) {
    const sessionId = trimmed.slice(8).trim();
    if (sessionId) {
      return `session:${sessionId}`;
    }
  }
  return undefined;
}

function normalizeWakeMode(raw: unknown) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "now" || trimmed === "next-heartbeat") {
    return trimmed;
  }
  return undefined;
}

function copyTopLevelAgentTurnFields(next: UnknownRecord, payload: UnknownRecord) {
  const copyString = (field: "model" | "thinking") => {
    if (typeof payload[field] === "string" && payload[field].trim()) {
      return;
    }
    const value = next[field];
    if (typeof value === "string" && value.trim()) {
      payload[field] = value.trim();
    }
  };
  copyString("model");
  copyString("thinking");

  if (typeof payload.timeoutSeconds !== "number" && typeof next.timeoutSeconds === "number") {
    payload.timeoutSeconds = next.timeoutSeconds;
  }
  if (
    typeof payload.allowUnsafeExternalContent !== "boolean" &&
    typeof next.allowUnsafeExternalContent === "boolean"
  ) {
    payload.allowUnsafeExternalContent = next.allowUnsafeExternalContent;
  }
}

function stripLegacyTopLevelFields(next: UnknownRecord) {
  delete next.model;
  delete next.thinking;
  delete next.timeoutSeconds;
  delete next.allowUnsafeExternalContent;
  delete next.message;
  delete next.text;
  delete next.deliver;
  delete next.channel;
  delete next.to;
  delete next.threadId;
  delete next.bestEffortDeliver;
  delete next.provider;
}

export function normalizeCronJobInput(
  raw: unknown,
  options: NormalizeOptions = DEFAULT_OPTIONS,
): UnknownRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const base = unwrapJob(raw);
  const next: UnknownRecord = { ...base };

  if ("agentId" in base) {
    const agentId = base.agentId;
    if (agentId === null) {
      next.agentId = null;
    } else if (typeof agentId === "string") {
      const trimmed = agentId.trim();
      if (trimmed) {
        next.agentId = sanitizeAgentId(trimmed);
      } else {
        delete next.agentId;
      }
    }
  }

  if ("sessionKey" in base) {
    const sessionKey = base.sessionKey;
    if (sessionKey === null) {
      next.sessionKey = null;
    } else if (typeof sessionKey === "string") {
      const trimmed = sessionKey.trim();
      if (trimmed) {
        next.sessionKey = trimmed;
      } else {
        delete next.sessionKey;
      }
    }
  }

  if ("enabled" in base) {
    const enabled = base.enabled;
    if (typeof enabled === "boolean") {
      next.enabled = enabled;
    } else if (typeof enabled === "string") {
      const trimmed = enabled.trim().toLowerCase();
      if (trimmed === "true") {
        next.enabled = true;
      }
      if (trimmed === "false") {
        next.enabled = false;
      }
    }
  }

  if ("sessionTarget" in base) {
    const normalized = normalizeSessionTarget(base.sessionTarget);
    if (normalized) {
      next.sessionTarget = normalized;
    } else {
      delete next.sessionTarget;
    }
  }

  if ("wakeMode" in base) {
    const normalized = normalizeWakeMode(base.wakeMode);
    if (normalized) {
      next.wakeMode = normalized;
    } else {
      delete next.wakeMode;
    }
  }

  if (isRecord(base.schedule)) {
    next.schedule = coerceSchedule(base.schedule);
  }

  if (!("payload" in next) || !isRecord(next.payload)) {
    const message = typeof next.message === "string" ? next.message.trim() : "";
    const text = typeof next.text === "string" ? next.text.trim() : "";
    if (message) {
      next.payload = { kind: "agentTurn", message };
    } else if (text) {
      next.payload = { kind: "systemEvent", text };
    }
  }

  if (isRecord(base.payload)) {
    next.payload = coercePayload(base.payload);
  }

  if (isRecord(base.delivery)) {
    next.delivery = coerceDelivery(base.delivery);
  }

  if ("isolation" in next) {
    delete next.isolation;
  }

  const payload = isRecord(next.payload) ? next.payload : null;
  if (payload && payload.kind === "agentTurn") {
    copyTopLevelAgentTurnFields(next, payload);
  }
  stripLegacyTopLevelFields(next);

  if (options.applyDefaults) {
    if (!next.wakeMode) {
      next.wakeMode = "now";
    }
    if (typeof next.enabled !== "boolean") {
      next.enabled = true;
    }
    if (
      (typeof next.name !== "string" || !next.name.trim()) &&
      isRecord(next.schedule) &&
      isRecord(next.payload)
    ) {
      next.name = inferLegacyName({
        schedule: next.schedule as { kind?: unknown; everyMs?: unknown; expr?: unknown },
        payload: next.payload as { kind?: unknown; text?: unknown; message?: unknown },
      });
    } else if (typeof next.name === "string") {
      const trimmed = next.name.trim();
      if (trimmed) {
        next.name = trimmed;
      }
    }
    if (!next.sessionTarget && isRecord(next.payload)) {
      const kind = typeof next.payload.kind === "string" ? next.payload.kind : "";
      // Keep default behavior unchanged for backward compatibility:
      // - systemEvent defaults to "main"
      // - agentTurn defaults to "isolated" (NOT "current", to avoid token accumulation)
      // Users must explicitly specify "current" or "session:xxx" for custom session binding
      if (kind === "systemEvent") {
        next.sessionTarget = "main";
      } else if (kind === "agentTurn") {
        next.sessionTarget = "isolated";
      }
    }

    // Resolve "current" sessionTarget to the actual sessionKey from context
    if (next.sessionTarget === "current") {
      if (options.sessionContext?.sessionKey) {
        const sessionKey = options.sessionContext.sessionKey.trim();
        if (sessionKey) {
          // Store as session:customId format for persistence
          next.sessionTarget = `session:${sessionKey}`;
        }
      }
      // If "current" wasn't resolved, fall back to "isolated" behavior
      // This handles CLI/headless usage where no session context exists
      if (next.sessionTarget === "current") {
        next.sessionTarget = "isolated";
      }
    }
    if (next.sessionTarget === "current") {
      const sessionKey = options.sessionContext?.sessionKey?.trim();
      if (sessionKey) {
        next.sessionTarget = `session:${sessionKey}`;
      } else {
        next.sessionTarget = "isolated";
      }
    }
    if (
      "schedule" in next &&
      isRecord(next.schedule) &&
      next.schedule.kind === "at" &&
      !("deleteAfterRun" in next)
    ) {
      next.deleteAfterRun = true;
    }
    if ("schedule" in next && isRecord(next.schedule) && next.schedule.kind === "cron") {
      const schedule = next.schedule as UnknownRecord;
      const explicit = normalizeCronStaggerMs(schedule.staggerMs);
      if (explicit !== undefined) {
        schedule.staggerMs = explicit;
      } else {
        const expr = typeof schedule.expr === "string" ? schedule.expr : "";
        const defaultStaggerMs = resolveDefaultCronStaggerMs(expr);
        if (defaultStaggerMs !== undefined) {
          schedule.staggerMs = defaultStaggerMs;
        }
      }
    }
    const payload = isRecord(next.payload) ? next.payload : null;
    const payloadKind = payload && typeof payload.kind === "string" ? payload.kind : "";
    const sessionTarget = typeof next.sessionTarget === "string" ? next.sessionTarget : "";
    // Support "isolated", custom session IDs (session:xxx), and resolved "current" as isolated-like targets
    const isIsolatedAgentTurn =
      sessionTarget === "isolated" ||
      sessionTarget === "current" ||
      sessionTarget.startsWith("session:") ||
      (sessionTarget === "" && payloadKind === "agentTurn");
    const hasDelivery = "delivery" in next && next.delivery !== undefined;
    if (!hasDelivery && isIsolatedAgentTurn && payloadKind === "agentTurn") {
      next.delivery = { mode: "announce" };
    }
  }

  return next;
}

export function normalizeCronJobCreate(
  raw: unknown,
  options?: Omit<NormalizeOptions, "applyDefaults">,
): CronJobCreate | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: true,
    ...options,
  }) as CronJobCreate | null;
}

export function normalizeCronJobPatch(
  raw: unknown,
  options?: NormalizeOptions,
): CronJobPatch | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: false,
    ...options,
  }) as CronJobPatch | null;
}

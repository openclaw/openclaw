import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { sanitizeAgentId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import {
  TimeoutSecondsFieldSchema,
  TrimmedNonEmptyStringFieldSchema,
  parseDeliveryInput,
  parseOptionalField,
} from "./delivery-field-schemas.js";
import { parseAbsoluteTimeMs } from "./parse.js";
import { coerceFiniteScheduleNumber } from "./schedule-number.js";
import { inferCronJobName } from "./service/normalize.js";
import {
  assertSafeCronSessionTargetId,
  resolveCronCurrentSessionTarget,
} from "./session-target.js";
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

function normalizeTrimmedStringArray(
  value: unknown,
  options?: { allowNull?: boolean },
): string[] | null | undefined {
  if (Array.isArray(value)) {
    const normalized = normalizeTrimmedStringList(value);
    if (normalized.length === 0 && value.length > 0) {
      return undefined;
    }
    return normalized;
  }
  if (options?.allowNull && value === null) {
    return null;
  }
  return undefined;
}

function coerceSchedule(schedule: UnknownRecord) {
  const next: UnknownRecord = { ...schedule };
  const rawKind = normalizeLowercaseStringOrEmpty(schedule.kind);
  const kind = rawKind === "at" || rawKind === "every" || rawKind === "cron" ? rawKind : undefined;
  const exprRaw = normalizeOptionalString(schedule.expr) ?? "";
  const everyMs = coerceFiniteScheduleNumber(schedule.everyMs);
  const anchorMs = coerceFiniteScheduleNumber(schedule.anchorMs);
  const atString = normalizeOptionalString(schedule.at) ?? "";
  const parsedAtMs = atString ? parseAbsoluteTimeMs(atString) : null;

  if (kind) {
    next.kind = kind;
  }

  const parsedAtIso = parsedAtMs !== null ? timestampMsToIsoString(parsedAtMs) : undefined;
  if (atString) {
    next.at = parsedAtIso ?? atString;
  } else if (parsedAtIso !== undefined) {
    next.at = parsedAtIso;
  }

  if (exprRaw) {
    next.expr = exprRaw;
  } else if ("expr" in next) {
    delete next.expr;
  }

  if (everyMs !== undefined && everyMs >= 1) {
    next.everyMs = Math.floor(everyMs);
  }
  if (anchorMs !== undefined && anchorMs >= 0) {
    next.anchorMs = Math.floor(anchorMs);
  }
  const staggerMs = normalizeCronStaggerMs(schedule.staggerMs);
  if (staggerMs !== undefined) {
    next.staggerMs = staggerMs;
  } else if ("staggerMs" in next) {
    delete next.staggerMs;
  }

  if (next.kind === "at") {
    delete next.everyMs;
    delete next.anchorMs;
    delete next.expr;
    delete next.tz;
    delete next.staggerMs;
  } else if (next.kind === "every") {
    delete next.at;
    delete next.expr;
    delete next.tz;
    delete next.staggerMs;
  } else if (next.kind === "cron") {
    delete next.at;
    delete next.everyMs;
    delete next.anchorMs;
  }

  return next;
}

function coercePayload(payload: UnknownRecord) {
  const next: UnknownRecord = { ...payload };
  const kindRaw = normalizeLowercaseStringOrEmpty(next.kind);
  if (kindRaw === "agentturn") {
    next.kind = "agentTurn";
  } else if (kindRaw === "systemevent") {
    next.kind = "systemEvent";
  } else if (kindRaw) {
    next.kind = kindRaw;
  }
  if (typeof next.message === "string") {
    const trimmed = normalizeOptionalString(next.message) ?? "";
    if (trimmed) {
      next.message = trimmed;
    }
  }
  if (typeof next.text === "string") {
    const trimmed = normalizeOptionalString(next.text) ?? "";
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
  if ("fallbacks" in next) {
    const fallbacks = normalizeTrimmedStringArray(next.fallbacks);
    if (fallbacks !== undefined) {
      next.fallbacks = fallbacks;
    } else {
      delete next.fallbacks;
    }
  }
  if ("toolsAllow" in next) {
    const toolsAllow = normalizeTrimmedStringArray(next.toolsAllow, { allowNull: true });
    if (toolsAllow !== undefined) {
      next.toolsAllow = toolsAllow;
    } else {
      delete next.toolsAllow;
    }
  }
  if (
    "allowUnsafeExternalContent" in next &&
    typeof next.allowUnsafeExternalContent !== "boolean"
  ) {
    delete next.allowUnsafeExternalContent;
  }
  if (next.kind === "systemEvent") {
    delete next.message;
    delete next.model;
    delete next.fallbacks;
    delete next.thinking;
    delete next.timeoutSeconds;
    delete next.lightContext;
    delete next.allowUnsafeExternalContent;
    delete next.toolsAllow;
  } else if (next.kind === "agentTurn") {
    delete next.text;
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
  if ("completionDestination" in next) {
    if (next.completionDestination === null) {
      next.completionDestination = null;
    } else {
      const completionDestination = isRecord(next.completionDestination)
        ? coerceCompletionDestination(next.completionDestination)
        : null;
      if (completionDestination) {
        next.completionDestination = completionDestination;
      } else {
        delete next.completionDestination;
      }
    }
  }
  return next;
}

function coerceCompletionDestination(value: UnknownRecord) {
  const mode = normalizeOptionalLowercaseString(value.mode);
  const to = normalizeOptionalString(value.to);
  if (mode !== "webhook") {
    return null;
  }
  return {
    mode,
    ...(to ? { to } : {}),
  } satisfies UnknownRecord;
}

function normalizeSessionTarget(raw: unknown) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower === "main" || lower === "isolated" || lower === "current") {
    return lower;
  }
  // Support custom session IDs with "session:" prefix
  if (lower.startsWith("session:")) {
    return `session:${assertSafeCronSessionTargetId(trimmed.slice(8))}`;
  }
  return undefined;
}

function normalizeWakeMode(raw: unknown) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (trimmed === "now" || trimmed === "next-heartbeat") {
    return trimmed;
  }
  return undefined;
}

export function normalizeCronJobInput(
  raw: unknown,
  options: NormalizeOptions = DEFAULT_OPTIONS,
): UnknownRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const base = raw;
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
      const trimmed = normalizeOptionalLowercaseString(enabled);
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

  if (isRecord(base.payload)) {
    next.payload = coercePayload(base.payload);
  }

  if (isRecord(base.delivery)) {
    next.delivery = coerceDelivery(base.delivery);
  }

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
      next.name = inferCronJobName({
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

    const resolvedSessionTarget = resolveCronCurrentSessionTarget({
      sessionTarget: typeof next.sessionTarget === "string" ? next.sessionTarget : undefined,
      sessionKey: options.sessionContext?.sessionKey,
    });
    if (resolvedSessionTarget !== undefined) {
      next.sessionTarget = resolvedSessionTarget;
    } else {
      delete next.sessionTarget;
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

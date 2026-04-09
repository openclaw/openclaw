import { parseAbsoluteTimeMs } from "../cron/parse.js";
import { coerceFiniteScheduleNumber } from "../cron/schedule.js";
import { inferLegacyName, normalizeOptionalText } from "../cron/service/normalize.js";
import { normalizeCronStaggerMs, resolveDefaultCronStaggerMs } from "../cron/stagger.js";
import { normalizeLegacyDeliveryInput } from "./doctor-cron-legacy-delivery.js";
import { migrateLegacyCronPayload } from "./doctor-cron-payload-migration.js";

type CronStoreIssueKey =
  | "jobId"
  | "legacyScheduleString"
  | "legacyScheduleCron"
  | "legacyPayloadKind"
  | "legacyPayloadProvider"
  | "legacyTopLevelPayloadFields"
  | "legacyTopLevelDeliveryFields"
  | "legacyDeliveryMode";

type CronStoreIssues = Partial<Record<CronStoreIssueKey, number>>;

type NormalizeCronStoreJobsResult = {
  issues: CronStoreIssues;
  jobs: Array<Record<string, unknown>>;
  mutated: boolean;
};

function incrementIssue(issues: CronStoreIssues, key: CronStoreIssueKey) {
  issues[key] = (issues[key] ?? 0) + 1;
}

function normalizePayloadKind(payload: Record<string, unknown>) {
  const raw = typeof payload.kind === "string" ? payload.kind.trim().toLowerCase() : "";
  if (raw === "agentturn") {
    if (payload.kind !== "agentTurn") {
      payload.kind = "agentTurn";
      return true;
    }
    return false;
  }
  if (raw === "systemevent") {
    if (payload.kind !== "systemEvent") {
      payload.kind = "systemEvent";
      return true;
    }
    return false;
  }
  return false;
}

function inferPayloadIfMissing(raw: Record<string, unknown>) {
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (message) {
    raw.payload = { kind: "agentTurn", message };
    return true;
  }
  if (text) {
    raw.payload = { kind: "systemEvent", text };
    return true;
  }
  if (command) {
    raw.payload = { kind: "systemEvent", text: command };
    return true;
  }
  return false;
}

function copyTopLevelAgentTurnFields(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  let mutated = false;

  const copyTrimmedString = (field: "model" | "thinking") => {
    const existing = payload[field];
    if (typeof existing === "string" && existing.trim()) {
      return;
    }
    const value = raw[field];
    if (typeof value === "string" && value.trim()) {
      payload[field] = value.trim();
      mutated = true;
    }
  };
  copyTrimmedString("model");
  copyTrimmedString("thinking");

  if (
    typeof payload.timeoutSeconds !== "number" &&
    typeof raw.timeoutSeconds === "number" &&
    Number.isFinite(raw.timeoutSeconds)
  ) {
    payload.timeoutSeconds = Math.max(0, Math.floor(raw.timeoutSeconds));
    mutated = true;
  }

  if (
    typeof payload.allowUnsafeExternalContent !== "boolean" &&
    typeof raw.allowUnsafeExternalContent === "boolean"
  ) {
    payload.allowUnsafeExternalContent = raw.allowUnsafeExternalContent;
    mutated = true;
  }

  if (typeof payload.deliver !== "boolean" && typeof raw.deliver === "boolean") {
    payload.deliver = raw.deliver;
    mutated = true;
  }
  if (
    typeof payload.channel !== "string" &&
    typeof raw.channel === "string" &&
    raw.channel.trim()
  ) {
    payload.channel = raw.channel.trim();
    mutated = true;
  }
  if (typeof payload.to !== "string" && typeof raw.to === "string" && raw.to.trim()) {
    payload.to = raw.to.trim();
    mutated = true;
  }
  if (
    !("threadId" in payload) &&
    ((typeof raw.threadId === "number" && Number.isFinite(raw.threadId)) ||
      (typeof raw.threadId === "string" && raw.threadId.trim()))
  ) {
    payload.threadId = typeof raw.threadId === "string" ? raw.threadId.trim() : raw.threadId;
    mutated = true;
  }
  if (
    typeof payload.bestEffortDeliver !== "boolean" &&
    typeof raw.bestEffortDeliver === "boolean"
  ) {
    payload.bestEffortDeliver = raw.bestEffortDeliver;
    mutated = true;
  }
  if (
    typeof payload.provider !== "string" &&
    typeof raw.provider === "string" &&
    raw.provider.trim()
  ) {
    payload.provider = raw.provider.trim();
    mutated = true;
  }

  return mutated;
}

function stripLegacyTopLevelFields(raw: Record<string, unknown>) {
  if ("model" in raw) {
    delete raw.model;
  }
  if ("thinking" in raw) {
    delete raw.thinking;
  }
  if ("timeoutSeconds" in raw) {
    delete raw.timeoutSeconds;
  }
  if ("allowUnsafeExternalContent" in raw) {
    delete raw.allowUnsafeExternalContent;
  }
  if ("message" in raw) {
    delete raw.message;
  }
  if ("text" in raw) {
    delete raw.text;
  }
  if ("deliver" in raw) {
    delete raw.deliver;
  }
  if ("channel" in raw) {
    delete raw.channel;
  }
  if ("to" in raw) {
    delete raw.to;
  }
  if ("threadId" in raw) {
    delete raw.threadId;
  }
  if ("bestEffortDeliver" in raw) {
    delete raw.bestEffortDeliver;
  }
  if ("provider" in raw) {
    delete raw.provider;
  }
  if ("command" in raw) {
    delete raw.command;
  }
  if ("timeout" in raw) {
    delete raw.timeout;
  }
}

export function normalizeStoredCronJobs(
  jobs: Array<Record<string, unknown>>,
): NormalizeCronStoreJobsResult {
  const issues: CronStoreIssues = {};
  let mutated = false;

  for (const raw of jobs) {
    const jobIssues = new Set<CronStoreIssueKey>();
    const trackIssue = (key: CronStoreIssueKey) => {
      if (jobIssues.has(key)) {
        return;
      }
      jobIssues.add(key);
      incrementIssue(issues, key);
    };

    const state = raw.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      raw.state = {};
      mutated = true;
    }

    const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
    const legacyJobId = typeof raw.jobId === "string" ? raw.jobId.trim() : "";
    if (!rawId && legacyJobId) {
      raw.id = legacyJobId;
      mutated = true;
      trackIssue("jobId");
    } else if (rawId && raw.id !== rawId) {
      raw.id = rawId;
      mutated = true;
    }
    if ("jobId" in raw) {
      delete raw.jobId;
      mutated = true;
      trackIssue("jobId");
    }

    if (typeof raw.schedule === "string") {
      const expr = raw.schedule.trim();
      raw.schedule = { kind: "cron", expr };
      mutated = true;
      trackIssue("legacyScheduleString");
    }

    const nameRaw = raw.name;
    if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
      raw.name = inferLegacyName({
        schedule: raw.schedule as never,
        payload: raw.payload as never,
      });
      mutated = true;
    } else {
      raw.name = nameRaw.trim();
    }

    const desc = normalizeOptionalText(raw.description);
    if (raw.description !== desc) {
      raw.description = desc;
      mutated = true;
    }

    if ("sessionKey" in raw) {
      const sessionKey =
        typeof raw.sessionKey === "string" ? normalizeOptionalText(raw.sessionKey) : undefined;
      if (raw.sessionKey !== sessionKey) {
        raw.sessionKey = sessionKey;
        mutated = true;
      }
    }

    if (typeof raw.enabled !== "boolean") {
      raw.enabled = true;
      mutated = true;
    }

    const wakeModeRaw = typeof raw.wakeMode === "string" ? raw.wakeMode.trim().toLowerCase() : "";
    if (wakeModeRaw === "next-heartbeat") {
      if (raw.wakeMode !== "next-heartbeat") {
        raw.wakeMode = "next-heartbeat";
        mutated = true;
      }
    } else if (wakeModeRaw === "now") {
      if (raw.wakeMode !== "now") {
        raw.wakeMode = "now";
        mutated = true;
      }
    } else {
      raw.wakeMode = "now";
      mutated = true;
    }

    const payload = raw.payload;
    if (
      (!payload || typeof payload !== "object" || Array.isArray(payload)) &&
      inferPayloadIfMissing(raw)
    ) {
      mutated = true;
      trackIssue("legacyTopLevelPayloadFields");
    }

    const payloadRecord =
      raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
        ? (raw.payload as Record<string, unknown>)
        : null;

    if (payloadRecord) {
      if (normalizePayloadKind(payloadRecord)) {
        mutated = true;
        trackIssue("legacyPayloadKind");
      }
      if (!payloadRecord.kind) {
        if (typeof payloadRecord.message === "string" && payloadRecord.message.trim()) {
          payloadRecord.kind = "agentTurn";
          mutated = true;
          trackIssue("legacyPayloadKind");
        } else if (typeof payloadRecord.text === "string" && payloadRecord.text.trim()) {
          payloadRecord.kind = "systemEvent";
          mutated = true;
          trackIssue("legacyPayloadKind");
        }
      }
      if (payloadRecord.kind === "agentTurn" && copyTopLevelAgentTurnFields(raw, payloadRecord)) {
        mutated = true;
      }
    }

    const hadLegacyTopLevelPayloadFields =
      "model" in raw ||
      "thinking" in raw ||
      "timeoutSeconds" in raw ||
      "allowUnsafeExternalContent" in raw ||
      "message" in raw ||
      "text" in raw ||
      "command" in raw ||
      "timeout" in raw;
    const hadLegacyTopLevelDeliveryFields =
      "deliver" in raw ||
      "channel" in raw ||
      "to" in raw ||
      "threadId" in raw ||
      "bestEffortDeliver" in raw ||
      "provider" in raw;
    if (hadLegacyTopLevelPayloadFields || hadLegacyTopLevelDeliveryFields) {
      stripLegacyTopLevelFields(raw);
      mutated = true;
      if (hadLegacyTopLevelPayloadFields) {
        trackIssue("legacyTopLevelPayloadFields");
      }
      if (hadLegacyTopLevelDeliveryFields) {
        trackIssue("legacyTopLevelDeliveryFields");
      }
    }

    if (payloadRecord) {
      const hadLegacyPayloadProvider =
        typeof payloadRecord.provider === "string" && payloadRecord.provider.trim().length > 0;
      if (migrateLegacyCronPayload(payloadRecord)) {
        mutated = true;
        if (hadLegacyPayloadProvider) {
          trackIssue("legacyPayloadProvider");
        }
      }
    }

    const schedule = raw.schedule;
    if (schedule && typeof schedule === "object" && !Array.isArray(schedule)) {
      const sched = schedule as Record<string, unknown>;
      const kind = typeof sched.kind === "string" ? sched.kind.trim().toLowerCase() : "";
      if (!kind && ("at" in sched || "atMs" in sched)) {
        sched.kind = "at";
        mutated = true;
      }
      const atRaw = typeof sched.at === "string" ? sched.at.trim() : "";
      const atMsRaw = sched.atMs;
      const parsedAtMs =
        typeof atMsRaw === "number"
          ? atMsRaw
          : typeof atMsRaw === "string"
            ? parseAbsoluteTimeMs(atMsRaw)
            : atRaw
              ? parseAbsoluteTimeMs(atRaw)
              : null;
      if (parsedAtMs !== null) {
        sched.at = new Date(parsedAtMs).toISOString();
        if ("atMs" in sched) {
          delete sched.atMs;
        }
        mutated = true;
      }

      const everyMsRaw = sched.everyMs;
      const everyMsCoerced = coerceFiniteScheduleNumber(everyMsRaw);
      const everyMs = everyMsCoerced !== undefined ? Math.floor(everyMsCoerced) : null;
      if (everyMs !== null && everyMsRaw !== everyMs) {
        sched.everyMs = everyMs;
        mutated = true;
      }
      if ((kind === "every" || sched.kind === "every") && everyMs !== null) {
        const anchorRaw = sched.anchorMs;
        const anchorCoerced = coerceFiniteScheduleNumber(anchorRaw);
        const normalizedAnchor =
          anchorCoerced !== undefined
            ? Math.max(0, Math.floor(anchorCoerced))
            : typeof raw.createdAtMs === "number" && Number.isFinite(raw.createdAtMs)
              ? Math.max(0, Math.floor(raw.createdAtMs))
              : typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs)
                ? Math.max(0, Math.floor(raw.updatedAtMs))
                : null;
        if (normalizedAnchor !== null && anchorRaw !== normalizedAnchor) {
          sched.anchorMs = normalizedAnchor;
          mutated = true;
        }
      }

      const exprRaw = typeof sched.expr === "string" ? sched.expr.trim() : "";
      const legacyCronRaw = typeof sched.cron === "string" ? sched.cron.trim() : "";
      let normalizedExpr = exprRaw;
      if (!normalizedExpr && legacyCronRaw) {
        normalizedExpr = legacyCronRaw;
        sched.expr = normalizedExpr;
        mutated = true;
        trackIssue("legacyScheduleCron");
      }
      if (typeof sched.expr === "string" && sched.expr !== normalizedExpr) {
        sched.expr = normalizedExpr;
        mutated = true;
      }
      if ("cron" in sched) {
        delete sched.cron;
        mutated = true;
        trackIssue("legacyScheduleCron");
      }
      if ((kind === "cron" || sched.kind === "cron") && normalizedExpr) {
        const explicitStaggerMs = normalizeCronStaggerMs(sched.staggerMs);
        const defaultStaggerMs = resolveDefaultCronStaggerMs(normalizedExpr);
        const targetStaggerMs = explicitStaggerMs ?? defaultStaggerMs;
        if (targetStaggerMs === undefined) {
          if ("staggerMs" in sched) {
            delete sched.staggerMs;
            mutated = true;
          }
        } else if (sched.staggerMs !== targetStaggerMs) {
          sched.staggerMs = targetStaggerMs;
          mutated = true;
        }
      }
    }

    const delivery = raw.delivery;
    if (delivery && typeof delivery === "object" && !Array.isArray(delivery)) {
      const modeRaw = (delivery as { mode?: unknown }).mode;
      if (typeof modeRaw === "string") {
        const lowered = modeRaw.trim().toLowerCase();
        if (lowered === "deliver") {
          (delivery as { mode?: unknown }).mode = "announce";
          mutated = true;
          trackIssue("legacyDeliveryMode");
        }
      } else if (modeRaw === undefined || modeRaw === null) {
        (delivery as { mode?: unknown }).mode = "announce";
        mutated = true;
      }
    }

    const isolation = raw.isolation;
    if (isolation && typeof isolation === "object" && !Array.isArray(isolation)) {
      delete raw.isolation;
      mutated = true;
    }

    const payloadKind =
      payloadRecord && typeof payloadRecord.kind === "string" ? payloadRecord.kind : "";
    const rawSessionTarget = typeof raw.sessionTarget === "string" ? raw.sessionTarget.trim() : "";
    const loweredSessionTarget = rawSessionTarget.toLowerCase();
    if (loweredSessionTarget === "main" || loweredSessionTarget === "isolated") {
      if (raw.sessionTarget !== loweredSessionTarget) {
        raw.sessionTarget = loweredSessionTarget;
        mutated = true;
      }
    } else if (loweredSessionTarget.startsWith("session:")) {
      const customSessionId = rawSessionTarget.slice(8).trim();
      if (customSessionId) {
        const normalizedSessionTarget = `session:${customSessionId}`;
        if (raw.sessionTarget !== normalizedSessionTarget) {
          raw.sessionTarget = normalizedSessionTarget;
          mutated = true;
        }
      }
    } else if (loweredSessionTarget === "current") {
      if (raw.sessionTarget !== "isolated") {
        raw.sessionTarget = "isolated";
        mutated = true;
      }
    } else {
      const inferredSessionTarget = payloadKind === "agentTurn" ? "isolated" : "main";
      if (raw.sessionTarget !== inferredSessionTarget) {
        raw.sessionTarget = inferredSessionTarget;
        mutated = true;
      }
    }

    const sessionTarget =
      typeof raw.sessionTarget === "string" ? raw.sessionTarget.trim().toLowerCase() : "";
    const isIsolatedAgentTurn =
      sessionTarget === "isolated" ||
      sessionTarget === "current" ||
      sessionTarget.startsWith("session:") ||
      (sessionTarget === "" && payloadKind === "agentTurn");
    const hasDelivery = delivery && typeof delivery === "object" && !Array.isArray(delivery);
    const normalizedLegacy = normalizeLegacyDeliveryInput({
      delivery: hasDelivery ? (delivery as Record<string, unknown>) : null,
      payload: payloadRecord,
    });

    if (isIsolatedAgentTurn && payloadKind === "agentTurn") {
      if (!hasDelivery && normalizedLegacy.delivery) {
        raw.delivery = normalizedLegacy.delivery;
        mutated = true;
      } else if (!hasDelivery) {
        raw.delivery = { mode: "announce" };
        mutated = true;
      } else if (normalizedLegacy.mutated && normalizedLegacy.delivery) {
        raw.delivery = normalizedLegacy.delivery;
        mutated = true;
      }
    } else if (normalizedLegacy.mutated && normalizedLegacy.delivery) {
      raw.delivery = normalizedLegacy.delivery;
      mutated = true;
    }
  }

  return { issues, jobs, mutated };
}

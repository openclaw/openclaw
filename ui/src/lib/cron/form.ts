import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { resolveCronTriggerMinIntervalMs } from "../../../../src/config/cron-limits.js";
import { hasCanonicalCronDeliveryMode } from "../../../../src/cron/store/delivery-codec.js";
import type { CronJob, CronPayload } from "../../api/types.ts";
import { toNumber } from "../format.ts";
import { parseCronDurationMs, parseFailureAlertCooldownMs } from "./decimal.ts";
import {
  formatDateTimeLocal,
  parseEverySchedule,
  durationMsToSecondsString,
  parseStaggerSchedule,
  parseCronScheduleAt,
} from "./form-schedule.ts";
import { DEFAULT_CRON_FORM } from "./state.ts";
import type { CronFieldErrors, CronFormState } from "./types.ts";
import { resolveCronWebhookDeliveryError } from "./webhook-url.ts";

const CRON_CHANNEL_LAST = "last";

function isCronFormSessionTarget(value: string): value is CronFormState["sessionTarget"] {
  return (
    value === "main" ||
    value === "isolated" ||
    value === "current" ||
    (value.startsWith("session:") && value.length > "session:".length)
  );
}

export function normalizeCronFormState(
  form: CronFormState,
  changed: Partial<CronFormState> = {},
): CronFormState {
  let normalized = form;
  if (!form.payloadLocked && form.payloadKind === "systemEvent" && form.sessionTarget !== "main") {
    normalized =
      changed.sessionTarget !== undefined
        ? { ...normalized, payloadKind: "agentTurn" }
        : { ...normalized, sessionTarget: "main" };
  }
  if (
    normalized.deliveryMode !== "announce" ||
    normalized.payloadKind === "agentTurn" ||
    (normalized.sessionTarget !== "main" && normalized.payloadLocked)
  ) {
    return normalized;
  }
  return {
    ...normalized,
    deliveryMode: "none",
  };
}

export function validateCronForm(form: CronFormState): CronFieldErrors {
  const errors: CronFieldErrors = {};
  if (!form.name.trim()) {
    errors.name = "cron.errors.nameRequired";
  }
  if (form.scheduleKind === "event" && form.payloadKind !== "agentTurn") {
    errors.payloadText = "cron.events.agentTurnRequired";
  }
  if (form.scheduleKind === "event" && form.eventSource === "mcp-events") {
    if (!form.eventServer.trim()) {
      errors.eventServer = "cron.events.eventServerRequired";
    }
    if (!form.eventName.trim()) {
      errors.eventName = "cron.events.eventNameRequired";
    }
    if (!safeParseJsonRecord(form.eventArguments)) {
      errors.eventArguments = "cron.events.eventArgumentsInvalid";
    }
  } else if (form.scheduleKind === "at") {
    if (!parseCronScheduleAt(form.scheduleAt)) {
      errors.scheduleAt = "cron.errors.scheduleAtInvalid";
    }
  } else if (form.scheduleKind === "every") {
    const everyMs = parseCronDurationMs(form.everyAmount, form.everyUnit);
    if (everyMs === undefined) {
      errors.everyAmount = "cron.errors.everyAmountInvalid";
    } else if (form.triggerEnabled && everyMs < resolveCronTriggerMinIntervalMs()) {
      errors.everyAmount = "cron.errors.triggerIntervalTooShort";
    }
  } else if (form.scheduleKind === "cron") {
    if (!form.cronExpr.trim()) {
      errors.cronExpr = "cron.errors.cronExprRequired";
    }
    if (!form.scheduleExact) {
      const staggerAmount = form.staggerAmount.trim();
      if (staggerAmount && !parseCronDurationMs(staggerAmount, form.staggerUnit, true)) {
        errors.staggerAmount = "cron.errors.staggerAmountInvalid";
      }
    }
  }
  if (form.triggerEnabled) {
    if (form.payloadKind === "script") {
      errors.triggerScript = "cron.errors.triggerScriptPayloadUnsupported";
    } else if (
      form.scheduleKind !== "every" &&
      form.scheduleKind !== "cron" &&
      form.scheduleKind !== "stream"
    ) {
      errors.triggerScript = "cron.errors.triggerScheduleUnsupported";
    } else if (!form.triggerScript.trim()) {
      errors.triggerScript = "cron.errors.triggerScriptRequired";
    }
  }
  if (!form.payloadLocked && !form.payloadText.trim()) {
    errors.payloadText =
      form.payloadKind === "systemEvent"
        ? "cron.errors.systemTextRequired"
        : "cron.errors.agentMessageRequired";
  }
  if (!form.payloadLocked && form.payloadKind === "agentTurn") {
    const timeoutRaw = form.timeoutSeconds.trim();
    if (timeoutRaw) {
      const timeout = toNumber(timeoutRaw, Number.NaN);
      if (!Number.isFinite(timeout) || timeout < 0) {
        errors.timeoutSeconds = "cron.errors.timeoutInvalid";
      }
    }
  }
  if (!form.deliveryMode) {
    errors.deliveryMode = "cron.errors.deliveryModeRequired";
  }
  if (form.activeHoursEnabled) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.activeHoursStart)) {
      errors.activeHoursStart = "cron.errors.activeHoursTime";
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.activeHoursEnd) && form.activeHoursEnd !== "24:00") {
      errors.activeHoursEnd = "cron.errors.activeHoursTime";
    }
    const timezone = form.activeHoursTimezone.trim();
    if (timezone && timezone !== "local" && timezone !== "user") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
      } catch {
        errors.activeHoursTimezone = "cron.errors.activeHoursTimezone";
      }
    }
  }
  if (form.deliveryMode === "webhook") {
    const error = resolveCronWebhookDeliveryError(form.deliveryTo);
    if (error) {
      errors.deliveryTo = error;
    }
  }
  if (form.failureAlertMode === "custom") {
    const afterRaw = form.failureAlertAfter.trim();
    if (afterRaw) {
      const after = toNumber(afterRaw, 0);
      if (!Number.isFinite(after) || after < 1) {
        errors.failureAlertAfter = "Failure alert threshold must be at least 1.";
      }
    }
    const cooldownRaw = form.failureAlertCooldownSeconds.trim();
    if (cooldownRaw && parseFailureAlertCooldownMs(cooldownRaw) === undefined) {
      errors.failureAlertCooldownSeconds = "Cooldown must be finite and 0 or greater.";
    }
  }
  return errors;
}

export function hasCronFormErrors(errors: CronFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function isReadOnlyCronPayload(payload: CronPayload | null): boolean {
  return payload?.kind === "command" || payload?.kind === "script";
}

export function jobToForm(job: CronJob, prev: CronFormState): CronFormState {
  const failureAlert = typeof job.failureAlert === "object" ? job.failureAlert : undefined;
  const payload = job.payload;
  const agentTurn = payload.kind === "agentTurn" ? payload : undefined;
  const payloadLocked = isReadOnlyCronPayload(payload);
  if (!isCronFormSessionTarget(job.sessionTarget)) {
    throw new TypeError(`Invalid cron session target: ${job.sessionTarget}`);
  }
  const next: CronFormState = {
    ...prev,
    name: job.name,
    description: job.description ?? "",
    agentId: job.agentId ?? "",
    sessionKey: job.sessionKey ?? "",
    clearAgent: false,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun ?? job.schedule.kind === "at",
    scheduleKind: job.schedule.kind,
    eventSource: "mcp-events",
    eventServer: "",
    eventName: "",
    eventArguments: "{}",
    scheduleAt: "",
    cronTz: "",
    scheduleExact: false,
    staggerAmount: "",
    staggerUnit: "seconds",
    activeHoursEnabled: job.activeHours !== undefined,
    activeHoursStart: job.activeHours?.start ?? DEFAULT_CRON_FORM.activeHoursStart,
    activeHoursEnd: job.activeHours?.end ?? DEFAULT_CRON_FORM.activeHoursEnd,
    activeHoursTimezone: job.activeHours?.timezone ?? "",
    idleOnly: job.idleOnly === true,
    payloadSkipIfScratchEmpty: payload?.kind === "agentTurn" && payload.skipIfScratchEmpty === true,
    deliveryTarget:
      job.delivery && job.delivery.mode !== "webhook" ? (job.delivery.target ?? "") : "",
    deliveryDirectPolicy:
      job.delivery && job.delivery.mode !== "webhook" ? (job.delivery.directPolicy ?? "") : "",
    triggerEnabled: job.trigger !== undefined,
    triggerScript: job.trigger?.script ?? "",
    triggerOnce: job.trigger?.once === true,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payloadKind: payload.kind,
    payloadLocked,
    payloadText:
      payload.kind === "systemEvent"
        ? payload.text
        : payload.kind === "agentTurn"
          ? payload.message
          : payload.kind === "command"
            ? payload.argv.join(" ")
            : payload.kind === "script"
              ? payload.script
              : "",
    payloadModel: agentTurn?.model ?? "",
    payloadThinking: agentTurn?.thinking ?? "",
    payloadLightContext: agentTurn?.lightContext === true,
    payloadIncludeReasoning: agentTurn?.includeReasoning === true,
    deliveryMode: hasCanonicalCronDeliveryMode(job.delivery) ? (job.delivery?.mode ?? "none") : "",
    deliveryChannel: job.delivery?.channel ?? CRON_CHANNEL_LAST,
    deliveryTo: job.delivery?.to ?? "",
    deliveryAccountId: job.delivery?.accountId ?? "",
    deliveryBestEffort: job.delivery?.bestEffort ?? false,
    deliveryThreadId: job.delivery?.threadId,
    deliveryCompletionDestination:
      job.delivery?.mode === "announce" ? job.delivery.completionDestination : undefined,
    deliveryFailureDestination: job.delivery?.failureDestination,
    failureAlertMode: job.failureAlert === false ? "disabled" : failureAlert ? "custom" : "inherit",
    failureAlertAfter: typeof failureAlert?.after === "number" ? String(failureAlert.after) : "",
    failureAlertCooldownSeconds:
      typeof failureAlert?.cooldownMs === "number"
        ? durationMsToSecondsString(failureAlert.cooldownMs)
        : "",
    failureAlertChannel: failureAlert?.channel ?? CRON_CHANNEL_LAST,
    failureAlertTo: failureAlert?.to ?? "",
    failureAlertDeliveryMode: failureAlert?.mode ?? "",
    failureAlertAccountId: failureAlert?.accountId ?? "",
    timeoutSeconds:
      typeof agentTurn?.timeoutSeconds === "number" ? String(agentTurn.timeoutSeconds) : "",
  };

  if (job.schedule.kind === "event") {
    next.eventSource = job.schedule.source;
    next.eventServer =
      typeof job.schedule.options.server === "string" ? job.schedule.options.server : "";
    next.eventName = typeof job.schedule.options.name === "string" ? job.schedule.options.name : "";
    next.eventArguments = JSON.stringify(job.schedule.options.arguments ?? {}, null, 2);
  } else if (job.schedule.kind === "at") {
    next.scheduleAt = formatDateTimeLocal(job.schedule.at);
  } else if (job.schedule.kind === "every") {
    Object.assign(next, parseEverySchedule(job.schedule.everyMs));
  } else if (job.schedule.kind === "cron") {
    next.cronExpr = job.schedule.expr;
    next.cronTz = job.schedule.tz ?? "";
    Object.assign(next, parseStaggerSchedule(job.schedule.staggerMs));
  }
  // Process-backed schedule kinds are shown read-only in the list and have no
  // editable schedule form fields; leave the cron/at/every fields at their defaults.

  return normalizeCronFormState(next);
}

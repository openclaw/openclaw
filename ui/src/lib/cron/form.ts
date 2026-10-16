import { hasCanonicalCronDeliveryMode } from "../../../../src/cron/store/delivery-codec.js";
import { isSystemMonitorDeclaration } from "../../../../src/cron/system-owned-declaration.js";
import { isSystemOwnedCronPayloadKind } from "../../../../src/cron/types.js";
import type { CronJob, CronPayload } from "../../api/types.ts";
import {
  formatDateTimeLocal,
  parseEverySchedule,
  durationMsToSecondsString,
  parseStaggerSchedule,
} from "./form-schedule.ts";
import { getCronJobPayload } from "./payload.ts";
import type { CronFormState } from "./types.ts";

const CRON_CHANNEL_LAST = "last";

function isCronFormSessionTarget(value: string): value is CronFormState["sessionTarget"] {
  return (
    value === "main" ||
    value === "isolated" ||
    value === "current" ||
    (value.startsWith("session:") && value.length > "session:".length)
  );
}

export const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  agentId: "",
  sessionKey: "",
  clearAgent: false,
  enabled: true,
  deleteAfterRun: false,
  scheduleKind: "every",
  eventSource: "mcp-events",
  eventServer: "",
  eventName: "",
  eventArguments: "{}",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  scheduleExact: false,
  staggerAmount: "",
  staggerUnit: "seconds",
  triggerEnabled: false,
  triggerScript: "",
  triggerOnce: false,
  sessionTarget: "isolated",
  wakeMode: "now",
  payloadKind: "agentTurn",
  payloadLocked: false,
  payloadText: "",
  payloadModel: "",
  payloadThinking: "",
  payloadLightContext: false,
  deliveryMode: "none",
  deliveryChannel: "last",
  deliveryTo: "",
  deliveryAccountId: "",
  deliveryBestEffort: false,
  deliveryThreadId: undefined,
  deliveryCompletionDestination: undefined,
  deliveryFailureDestination: undefined,
  failureAlertMode: "inherit",
  failureAlertAfter: "",
  failureAlertCooldownSeconds: "",
  failureAlertChannel: "last",
  failureAlertTo: "",
  failureAlertDeliveryMode: "",
  failureAlertAccountId: "",
  timeoutSeconds: "",
};

function supportsAnnounceDelivery(
  form: Pick<CronFormState, "sessionTarget" | "payloadKind" | "payloadLocked">,
) {
  return form.sessionTarget !== "main" && (form.payloadKind === "agentTurn" || form.payloadLocked);
}

export function normalizeCronFormState(
  form: CronFormState,
  changed: Partial<CronFormState> = {},
): CronFormState {
  let normalized = form;
  if (!form.payloadLocked) {
    if (changed.sessionTarget !== undefined) {
      const payloadKind = form.sessionTarget === "main" ? "systemEvent" : "agentTurn";
      if (form.payloadKind !== payloadKind) {
        normalized = { ...normalized, payloadKind };
      }
    } else if (form.payloadKind === "systemEvent" && form.sessionTarget !== "main") {
      normalized = { ...normalized, sessionTarget: "main" };
    } else if (form.payloadKind === "agentTurn" && form.sessionTarget === "main") {
      normalized = { ...normalized, sessionTarget: "isolated" };
    }
  }
  if (normalized.deliveryMode !== "announce" || supportsAnnounceDelivery(normalized)) {
    return normalized;
  }
  return {
    ...normalized,
    deliveryMode: "none",
  };
}

export function isReadOnlyCronPayload(
  payload: CronPayload | null,
  declarationKey?: string,
): boolean {
  return (
    payload?.kind === "command" ||
    payload?.kind === "script" ||
    isSystemOwnedCronPayloadKind(payload?.kind) ||
    isSystemMonitorDeclaration(declarationKey)
  );
}

export function jobToForm(job: CronJob, prev: CronFormState): CronFormState {
  const failureAlert = typeof job.failureAlert === "object" ? job.failureAlert : undefined;
  const payload = getCronJobPayload(job);
  const agentTurn = payload?.kind === "agentTurn" ? payload : undefined;
  const payloadLocked = isReadOnlyCronPayload(payload, job.declarationKey);
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
    triggerEnabled: job.trigger !== undefined,
    triggerScript: job.trigger?.script ?? "",
    triggerOnce: job.trigger?.once === true,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payloadKind: payload?.kind ?? DEFAULT_CRON_FORM.payloadKind,
    payloadLocked,
    payloadText:
      payload?.kind === "systemEvent"
        ? payload.text
        : payload?.kind === "agentTurn"
          ? payload.message
          : payload?.kind === "command"
            ? payload.argv.join(" ")
            : payload?.kind === "script"
              ? payload.script
              : "",
    payloadModel: agentTurn?.model ?? "",
    payloadThinking: agentTurn?.thinking ?? "",
    payloadLightContext: agentTurn?.lightContext === true,
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

import type { CronJob } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { resolveCronJobLastRunStatus } from "../cron-status.ts";
import { formatMs } from "../format.ts";

registerCronEnglish();

export function formatCronState(job: CronJob) {
  const state = job.state ?? {};
  const next = state.nextRunAtMs ? formatMs(state.nextRunAtMs) : t("common.na");
  const last = state.lastRunAtMs ? formatMs(state.lastRunAtMs) : t("common.na");
  const status = resolveCronJobLastRunStatus(job);
  return t("cron.job.state", { status, next, last });
}

export function formatCronPayload(job: CronJob) {
  const p = job.payload;
  // Newer Gateways name the stored kind; its agentTurn payload is only a placeholder.
  if (job.payloadSource?.kind === "pluginCommand") {
    return t("cron.job.pluginCommand", {
      command: job.payloadSource.command,
      plugin: job.payloadSource.pluginId,
    });
  }
  if (p.kind === "systemEvent") {
    return t("cron.job.system", { text: p.text });
  }
  if (p.kind === "command") {
    return t("cron.job.command", { command: p.argv.join(" ") });
  }
  if (p.kind === "script") {
    return t("cron.job.script", { script: p.script });
  }
  const base = t("cron.job.agent", { message: p.message });
  const delivery = job.delivery;
  if (delivery && delivery.mode !== "none") {
    const target =
      delivery.mode === "webhook"
        ? delivery.to
          ? ` (${delivery.to})`
          : ""
        : delivery.channel || delivery.to
          ? ` (${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""})`
          : "";
    return `${base} · ${delivery.mode}${target}`;
  }
  return base;
}

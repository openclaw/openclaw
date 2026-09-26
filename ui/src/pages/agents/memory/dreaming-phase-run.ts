// What a dreaming phase chip on the Memory page shows about its schedule.
import { t } from "../../../i18n/index.ts";

export type DreamingPhaseInfo = {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
};

function formatPhaseTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * What the phase chip shows: the next scheduled run, or — for a phase that
 * runs on an event rather than a timer and so has no next run — when it last
 * ran. A dash only when neither is known.
 */
export function formatPhaseRun(phase?: DreamingPhaseInfo): string {
  if (phase?.nextRunAtMs) {
    return formatPhaseTime(phase.nextRunAtMs);
  }
  if (phase?.lastRunAtMs) {
    return t("dreaming.phase.lastRun", { time: formatPhaseTime(phase.lastRunAtMs) });
  }
  return "—";
}

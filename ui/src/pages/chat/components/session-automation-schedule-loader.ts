import { createMemo } from "solid-js";
import type { CronJob } from "../../../api/types.ts";
import { nonCronSessionAutomationSchedule } from "./session-automation-schedule-non-cron.ts";

/** Share one formatter read across rows, loading the cron grammar only when displayed. */
export function createSessionAutomationSchedule() {
  const formatter = createMemo(
    async () => {
      const { sessionAutomationSchedule } = await import("./session-automation-schedule.ts");
      return sessionAutomationSchedule;
    },
    { lazy: true },
  );
  return (schedule: CronJob["schedule"]): string =>
    schedule.kind === "cron" ? formatter()(schedule) : nonCronSessionAutomationSchedule(schedule);
}

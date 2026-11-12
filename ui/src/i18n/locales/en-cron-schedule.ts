import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Schedule wording follows the lazy presenter consumers (cron, agent cron panel, sessions, debug)
// and reuses the startup `cron` anchor so it adds no startup bytes.
const catalog = {
  cron: {
    scheduleLabel: {
      at: "At {time}",
      every: "Every {duration}",
      onExit: "On exit: {command}",
      event: "Event: {name}",
      stream: "Stream: {command}",
      cron: "Cron {expr}",
      withCwd: "{value} (cwd: {cwd})",
      withTimeZone: "{value} ({timeZone})",
      nextRunToday: "Next run today at {time}",
      nextRunTomorrow: "Next run tomorrow at {time}",
      nextRunOn: "Next run on {day} at {time}",
      noNextRun: "Not scheduled to run again",
    },
  },
} satisfies TranslationMap;

export const registerCronScheduleEnglish = Object.assign(
  () => {
    Object.assign(en.cron, catalog.cron);
  },
  { catalog },
);

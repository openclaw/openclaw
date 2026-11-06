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
    },
  },
} satisfies TranslationMap;

export const registerCronScheduleEnglish = Object.assign(
  () => {
    Object.assign(en.cron, catalog.cron);
  },
  { catalog },
);

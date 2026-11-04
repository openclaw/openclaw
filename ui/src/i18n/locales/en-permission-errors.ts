import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enPermissionErrors = {
  runtimeErrors: {
    permissionDenied:
      "You don't have permission to view {feature}. Ask the person who manages OpenClaw for access.",
    permissionFeatures: {
      "channel status": "channel status",
      "cron status": "cron status",
      "existing chat history": "existing chat history",
      logs: "logs",
      "model providers": "model providers",
      "scheduled tasks": "scheduled tasks",
      "the context breakdown": "the context breakdown",
      usage: "usage",
      "usage details": "usage details",
      "agent list": "agent list",
      "effective tools": "effective tools",
    },
  },
} satisfies TranslationMap;

export const registerPermissionErrorsEnglish = Object.assign(
  () => {
    Object.assign(en.runtimeErrors, enPermissionErrors.runtimeErrors);
  },
  { catalog: enPermissionErrors },
);

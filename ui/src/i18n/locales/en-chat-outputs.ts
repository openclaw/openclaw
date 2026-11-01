import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatOutputs = {
  outputs: {
    viewAll: "View all",
    dashboard: en.outputs.dashboard,
    files: "Files",
    loading: "Loading outputs…",
    updating: "Updating outputs…",
    loadingDashboard: "Loading dashboard…",
    emptyTitle: "No outputs yet",
    emptyDescription: "Files and dashboards from the session appear here.",
  },
} satisfies TranslationMap;

export const registerChatOutputsEnglish = Object.assign(
  () => {
    Object.assign(en.outputs, enChatOutputs.outputs);
  },
  { catalog: enChatOutputs },
);

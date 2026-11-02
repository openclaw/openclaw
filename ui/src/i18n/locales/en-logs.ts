import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enLogs = {
  gatewayLogs: {
    title: "Logs",
    subtitle: "Gateway file logs (JSONL).",
    exportButton: "Export {label}",
    exportLabels: {
      filtered: "filtered",
      visible: "visible",
    },
    filter: "Filter",
    searchPlaceholder: "Search logs",
    autoFollow: "Auto-follow",
    file: "File: {file}",
    truncated: "Log output truncated; showing latest chunk.",
    empty: "No log entries.",
  },
} satisfies TranslationMap;

export const registerLogsEnglish = Object.assign(
  () => Object.assign(en.gatewayLogs, enLogs.gatewayLogs),
  { catalog: enLogs },
);

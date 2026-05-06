export const TOOL_SUMMARY_LOCALES = ["en", "zh-CN", "ko", "ja"] as const;

export type ToolSummaryLocale = (typeof TOOL_SUMMARY_LOCALES)[number];

export function normalizeToolSummaryLocale(locale?: ToolSummaryLocale): ToolSummaryLocale {
  return locale === "zh-CN" || locale === "ko" || locale === "ja" ? locale : "en";
}

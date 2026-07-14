export type MarkLanguage = "english" | "中文";

export type MarkPreset = {
  symbol: string;
  id: string;
  index: number;
  aliases: readonly string[];
};

export const MARK_SEPARATOR = "\u2800";
export const MARK_LANGUAGE_ENGLISH: MarkLanguage = "english";
export const MARK_LANGUAGE_CHINESE: MarkLanguage = "中文";

export const MARK_PRESETS: readonly MarkPreset[] = [
  { symbol: "🚧", id: "进行中", index: 0, aliases: ["in-progress", "ongoing", "wip"] },
  { symbol: "✅", id: "已完成", index: 1, aliases: ["done", "completed", "finished"] },
  { symbol: "⏸️", id: "暂停", index: 2, aliases: ["paused", "hold", "suspended"] },
  { symbol: "🔥", id: "紧急", index: 3, aliases: ["urgent", "critical", "asap"] },
  { symbol: "📌", id: "常驻", index: 4, aliases: ["pinned", "reference", "keep"] },
  { symbol: "💡", id: "想法", index: 5, aliases: ["idea", "spark", "note"] },
];

export const SESSION_ICON_EMOJI_CHOICES = [
  "🦞",
  "🚀",
  "🐛",
  "✅",
  "🔥",
  "📦",
  "🧪",
  "📝",
  "🔍",
  "⚡",
  "🎯",
] as const;

export function sessionEmojiPickerShortcut(): readonly string[] | null {
  const platform = globalThis.navigator?.platform ?? "";
  if (/Mac|iPhone|iPad|iPod/u.test(platform)) {
    return ["⌃", "⌘", "Space"];
  }
  return /Win/u.test(platform) ? ["Win", "+", "."] : null;
}

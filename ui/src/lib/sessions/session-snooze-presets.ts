// Preset construction belongs to the lazy snooze menu, not sidebar boot state.
type SnoozePreset = {
  id: "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";
  snoozedUntil: number;
};

export function resolveSessionSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const hour = 60 * 60 * 1000;
  const presets: SnoozePreset[] = [
    { id: "hour", snoozedUntil: now.getTime() + hour },
    { id: "three-hours", snoozedUntil: now.getTime() + 3 * hour },
  ];
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() - now.getTime() > hour) {
    presets.push({ id: "evening", snoozedUntil: evening.getTime() });
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  presets.push({ id: "tomorrow", snoozedUntil: tomorrow.getTime() });
  const nextMonday = new Date(now);
  nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
  nextMonday.setHours(9, 0, 0, 0);
  if (nextMonday.getTime() !== tomorrow.getTime()) {
    presets.push({ id: "next-week", snoozedUntil: nextMonday.getTime() });
  }
  return presets;
}

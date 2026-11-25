// Dependency-free so time-zone tests can load it in a child process with its own TZ.
import type { ActivityTimeFilter } from "./session-activity.ts";

export function activityPulseBucketStart(
  time: ActivityTimeFilter,
  timestamp: number,
  index: number,
): number {
  const date = new Date(timestamp);
  if (time === "24h") {
    // Subtract rather than setMinutes(0): a repeated DST hour would resolve to its first occurrence.
    const hourStart =
      timestamp - date.getMinutes() * 60_000 - date.getSeconds() * 1_000 - date.getMilliseconds();
    return hourStart + index * 3_600_000;
  }
  return time === "all"
    ? new Date(date.getFullYear(), date.getMonth() + index, 1).getTime()
    : new Date(date.getFullYear(), date.getMonth(), date.getDate() + index).getTime();
}

export function activityPulseBoundaries(time: ActivityTimeFilter, now: number): number[] {
  const bucketCount = { "24h": 25, "7d": 8, "30d": 31, all: 12 }[time];
  const start =
    time === "24h" ? now - 24 * 3_600_000 : activityPulseBucketStart(time, now, 1 - bucketCount);
  return Array.from({ length: bucketCount + 1 }, (_, index) =>
    activityPulseBucketStart(time, start, index),
  );
}

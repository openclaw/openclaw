import { randomBytes } from "node:crypto";
import os from "node:os";

export type BackupRetention = {
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
};
export type BackupRetentionOptions = {
  [K in keyof BackupRetention]?: string | number;
};

export function normalizeBackupRetention(options: BackupRetentionOptions): BackupRetention {
  const result: BackupRetention = {};
  for (const key of ["keepDaily", "keepWeekly", "keepMonthly"] as const) {
    const value = options[key];
    if (value === undefined) {
      continue;
    }
    const count = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(
        `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a nonnegative integer.`,
      );
    }
    result[key] = count;
  }
  return result;
}

export function resolveBackupNamespace(namespace?: string): string {
  const value = namespace ?? os.hostname().replace(/[^A-Za-z0-9._-]/g, "-");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value) || value === "." || value === "..") {
    throw new Error(
      "Backup namespace must be 1–128 letters, digits, dots, underscores or hyphens, and cannot be . or .. .",
    );
  }
  return value;
}

export function createRemoteBackupKey(nowMs = Date.now()): string {
  return `${new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}-${randomBytes(4).toString("hex")}.tar.gz`;
}

/** Only consumer-owned keys with real UTC timestamps participate in listing or deletion. */
export function parseRemoteBackupTimestamp(key: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[a-f0-9]{8}\.tar\.gz$/.exec(key);
  if (!match) {
    return undefined;
  }
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === iso
    ? timestamp
    : undefined;
}

/** Keep the newest snapshot in each selected nonempty UTC calendar bucket (Monday weeks). */
export function selectBackupRetention(
  keys: readonly string[],
  options: BackupRetention,
): {
  kept: string[];
  deleted: string[];
} {
  const backups = [...new Set(keys)]
    .flatMap((key) => {
      const timestamp = parseRemoteBackupTimestamp(key);
      return timestamp === undefined ? [] : [{ key, timestamp }];
    })
    .toSorted((a, b) => b.timestamp - a.timestamp || b.key.localeCompare(a.key));
  if (Object.values(options).every((value) => value === undefined)) {
    return { kept: backups.map(({ key }) => key), deleted: [] };
  }
  const kept = new Set<string>(backups.slice(0, 1).map(({ key }) => key));
  const buckets = {
    keepDaily: new Set<string>(),
    keepWeekly: new Set<string>(),
    keepMonthly: new Set<string>(),
  };
  for (const { key, timestamp } of backups) {
    const date = new Date(timestamp);
    const day = date.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const week = date.toISOString().slice(0, 10);
    for (const [period, bucket] of [
      ["keepDaily", day],
      ["keepWeekly", week],
      ["keepMonthly", month],
    ] as const) {
      const seen = buckets[period];
      if (!seen.has(bucket) && seen.size < (options[period] ?? 0)) {
        kept.add(key);
        seen.add(bucket);
      }
    }
  }
  return {
    kept: backups.filter(({ key }) => kept.has(key)).map(({ key }) => key),
    deleted: backups.filter(({ key }) => !kept.has(key)).map(({ key }) => key),
  };
}

export function createLegacyCronJob(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "legacy-job",
    name: "Legacy job",
    notify: true,
    createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
    schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
    payload: {
      kind: "systemEvent",
      text: "Morning brief",
    },
    state: {},
    ...overrides,
  };
}

export function createCurrentCronJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "sqlite-job",
    name: "SQLite job",
    enabled: true,
    createdAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "systemEvent",
      text: "SQLite brief",
    },
    state: {},
    ...overrides,
  };
}

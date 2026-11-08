import type { CronJob } from "../api/types.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { cronRuns } from "./cron-fixtures.test-support.ts";

export function createCronLayoutMethodResponses() {
  const jobs: CronJob[] = [
    {
      id: "healthy",
      configRevision: "healthy-revision",
      name: "Healthy automation",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "healthy" },
      state: { lastRunStatus: "ok" },
    },
    {
      id: "failing",
      configRevision: "failing-revision",
      name: "Failing automation",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "failing" },
      state: { lastRunStatus: "error" },
    },
  ];
  return {
    "agents.list": {
      agents: [
        { id: "main", identity: { name: "Molty" }, name: "Molty" },
        { id: "writer", identity: { name: "Writer" }, name: "Writer" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    },
    "cron.list": cronListResponseFixture({
      jobs,
      snapshotRevision: "settings-layout",
      total: jobs.length,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    }),
    "cron.runs": cronRuns([]),
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  };
}

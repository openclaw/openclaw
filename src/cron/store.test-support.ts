import type { CronStoreFile } from "./types.js";

type FixtureStore = { version: 1; jobs: [CronStoreFile["jobs"][number]] };

export function makeStore(jobId: string, enabled: boolean): FixtureStore {
  const now = Date.now();
  return {
    version: 1,
    jobs: [
      {
        id: jobId,
        name: `Job ${jobId}`,
        enabled,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: `tick-${jobId}` },
        state: {},
      },
    ],
  };
}

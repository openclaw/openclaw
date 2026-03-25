/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { renderApp } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";
import { OpenClawApp } from "./app.ts";
import type { CronJob } from "./types.ts";

describe("renderApp", () => {
  it("ignores cron jobs with malformed payloads when building model suggestions", () => {
    const app = new OpenClawApp();
    app.connected = true;
    app.cronJobs = [
      {
        id: "job-bad-payload",
        name: "Broken cron job",
        sessionKey: "agent:main:main",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: undefined as unknown as CronJob["payload"],
        delivery: { mode: "announce" },
      } as unknown as CronJob,
    ];

    expect(() => renderApp(app as unknown as AppViewState)).not.toThrow();
  });
});

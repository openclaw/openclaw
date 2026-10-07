import path from "node:path";
import { expect } from "vitest";
import { saveCronJobsStore } from "../cron/store.js";
import { drainSystemEvents, prepareAutomationSystemEvents } from "../infra/system-events.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNonEmptyString } from "./hooks-test-helpers.js";
import { testState } from "./test-helpers.runtime-state.js";
import { withGatewayServer } from "./test-helpers.server.js";

export const HOOKS_MAIN_SESSION_KEY = "agent:hooks:main";

export async function withScheduledHookReceivers(
  run: Parameters<typeof withGatewayServer>[0],
): Promise<void> {
  const storePath = path.join(
    requireNonEmptyString(process.env.OPENCLAW_STATE_DIR, "OPENCLAW_STATE_DIR"),
    "cron",
    "hook-receivers.json",
  );
  const now = Date.now();
  const nextRunAtMs = now + 86_400_000;
  const previousStore = testState.cronStorePath;
  const previousEnabled = testState.cronEnabled;
  testState.cronStorePath = storePath;
  testState.cronEnabled = true;
  try {
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: ["main", "hooks"].map((agentId) => ({
        id: `hook-receiver-${agentId}`,
        agentId,
        name: `Scheduled ${agentId} notices`,
        enabled: true,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "at", at: new Date(nextRunAtMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Review pending notices." },
        delivery: { mode: "none" },
        state: { nextRunAtMs },
      })),
    });
    await withEnvAsync({ OPENCLAW_SKIP_CRON: "0" }, () => withGatewayServer(run));
  } finally {
    testState.cronStorePath = previousStore;
    testState.cronEnabled = previousEnabled;
    drainSystemEvents(HOOKS_MAIN_SESSION_KEY);
  }
}

export async function consumeScheduledHookNotices(
  sessionKey: string,
  agentId: string,
  texts: string[],
) {
  const unrelated = await prepareAutomationSystemEvents(sessionKey, "another-automation");
  try {
    expect(unrelated.events).toEqual([]);
  } finally {
    unrelated.release();
  }
  const scheduled = await prepareAutomationSystemEvents(sessionKey, `hook-receiver-${agentId}`);
  try {
    expect(scheduled.events.map((event) => event.text)).toEqual(texts);
    scheduled.start();
  } finally {
    scheduled.release();
  }
}

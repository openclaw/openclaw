import path from "node:path";
import { expect, test, vi } from "vitest";
import { CronService } from "../cron/service.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { admitGatewayCronOccurrence } from "./server-cron-event-dispatch.js";
import {
  createSessionAutomationSource,
  registerSessionAutomationSource,
  sessionHasAutomation,
  unregisterSessionAutomationSource,
} from "./session-automation-index.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test("deleting a conversation does not disable its linked command automation", async () => {
  const { dir } = await createSessionStoreDir();
  const key = "agent:main:dashboard:command-owner";
  const sessionId = "command-owner";
  await writeSessionStore({ entries: { [key]: sessionStoreEntry(sessionId) } });
  const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
  const command = vi.fn(async () => ({ status: "ok" as const }));
  const cron = new CronService({
    storePath: path.join(dir, "cron", "jobs.json"),
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    defaultAgentId: "main",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
    runCommandJob: command,
    admitScheduledOccurrence: ({ job }) =>
      admitGatewayCronOccurrence(job, () => ({ cfg, agentId: "main" })),
  });
  const source = createSessionAutomationSource(cron, true);
  try {
    const job = await cron.add(
      {
        name: "Nightly backup",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "command", argv: ["echo", "synthetic backup"] },
      },
      { sourceConversation: { sessionKey: key, sessionId } },
    );
    registerSessionAutomationSource(source);
    expect(sessionHasAutomation(key, cfg, "main")).toBe(true);
    const deleted = await directSessionReq("sessions.delete", { key }, { context: { cron } });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect((await loadSessionEntryAsync(key)).entry).toBeUndefined();
    expect(cron.getJob(job.id)?.enabled).toBe(true);

    // Real deletion, storage and occurrence admission; only the host command is synthetic.
    await cron.run(job.id, "force");
    expect(command).toHaveBeenCalledOnce();
    expect(cron.getJob(job.id)).toMatchObject({ enabled: true, state: { lastRunStatus: "ok" } });
  } finally {
    unregisterSessionAutomationSource(source);
    cron.stop();
    await cron.waitForIdle();
  }
});

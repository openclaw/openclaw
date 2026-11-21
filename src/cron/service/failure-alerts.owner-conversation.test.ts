import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { sendGatewayCronFailureAlert } from "../../gateway/server-cron-notifications.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CronService } from "../service.js";
import { createNoopLogger } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";

// The scheduler and the real Gateway transport together: the incident was a routing
// decision in the transport, which the service suites replace with a mock.
it("notifies the owning conversation when a conversation-bound job's trigger fails", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-cron-owner-alert-" },
    async (state) => {
      const sessionStore = path.join(state.root, "agents", "main", "sessions", "sessions.json");
      const sessionKey = "agent:main:dashboard:owner";
      const scope = { agentId: "main", sessionKey, storePath: sessionStore };
      await replaceSessionEntry(scope, { sessionId: "owner-session", updatedAt: 1 });
      const cfg = { session: { store: sessionStore } };
      const storePath = state.path("cron", "jobs.json");
      let delivery: Promise<void> | undefined;
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: true,
        log: createNoopLogger(),
        cronConfig: { triggers: { enabled: true } },
        enqueueSystemEvent: vi.fn(),
        enqueueSessionEvent: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        evaluateCronTrigger: async () => ({
          kind: "error",
          code: "internal_error",
          error: "Error: GitHub search failed",
        }),
        sendCronFailureAlert: (params) => {
          delivery = sendGatewayCronFailureAlert({
            ...params,
            deps: {} as never,
            logger: createNoopLogger(),
            resolveCronAgent: () => ({ agentId: "main", cfg }),
          });
          return delivery;
        },
      });
      try {
        await cron.start();
        const job = await cron.add({
          name: "watcher",
          enabled: true,
          schedule: { kind: "cron", expr: "0 */6 * * *", staggerMs: 0 },
          trigger: { script: "json({ fire: false })" },
          sessionTarget: "current",
          sessionKey,
          owner: { agentId: "main", sessionKey },
          agentId: "main",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "check" },
          delivery: { mode: "announce" },
        });
        vi.setSystemTime(job.state.nextRunAtMs!);
        await cron.run(job.id, "due");
        await vi.waitFor(() => expect(delivery).toBeDefined());
        await delivery;

        const stored = (await loadCronStore(storePath)).jobs.find(({ id }) => id === job.id);
        expect(stored?.state).toMatchObject({
          lastFailureNotificationDelivered: true,
          lastFailureNotificationDeliveryStatus: "delivered",
        });
        const transcript = JSON.stringify(
          await loadTranscriptEvents({ ...scope, sessionId: "owner-session" }),
        );
        expect(transcript).toContain('Automation \\"watcher\\" failed');
      } finally {
        cron.stop();
        await closeOpenClawAgentDatabasesAsync(state.root);
      }
    },
  );
});

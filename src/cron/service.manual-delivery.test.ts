import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";
import { dispatchCronDelivery } from "./isolated-agent/delivery-dispatch.js";
import { makeBaseParams } from "./isolated-agent/delivery-dispatch.test-fixtures.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import type { CronEvent } from "./service/state.js";

const FOUR_HOURS_MS = 4 * 60 * 60_000;
const text = "Fresh result from this invocation.";

it.each(["force", "due"] as const)(
  "delivers according to the %s occurrence after the scheduled slot ages",
  (mode) =>
    withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-manual-delivery-" },
      async (state) => {
        const registry = captureActivePluginRegistrySnapshot();
        const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "fresh-result" }));
        const plugin = createOutboundTestPlugin({
          id: "telegram",
          outbound: { deliveryMode: "direct", sendText },
        });
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
        );
        let now = Date.now() - FOUR_HOURS_MS;
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
        };
        await state.writeConfig(cfg);
        const finished = createDeferred<CronEvent>();
        const cron = new CronService({
          ...cronTestDeps({ storePath: state.path("cron", "jobs.json") }),
          cronEnabled: false,
          defaultAgentId: "main",
          nowMs: () => now,
          onEvent: (event) => {
            if (event.action === "finished") {
              finished.resolve(event);
            }
          },
          runIsolatedAgentJob: async ({ job, abortSignal, deliveryAttemptFence }) => {
            const sessionKey = `agent:main:cron:${job.id}`;
            const deliveryPlan = resolveCronDeliveryPlan(job);
            const resolvedDelivery = await resolveDeliveryTarget(cfg, "main", {
              ...job,
              ...deliveryPlan,
            });
            const delivery = await dispatchCronDelivery({
              ...makeBaseParams({ synthesizedText: text, runStartedAt: now }),
              cfgWithAgentDefaults: cfg,
              job,
              deliveryAttemptFence,
              agentSessionKey: sessionKey,
              runSessionKey: sessionKey,
              resolvedDelivery,
              deliveryPlan,
              abortSignal,
              isAborted: () => abortSignal?.aborted === true,
            });
            const failure =
              delivery.disposition?.kind === "error" ? delivery.disposition : undefined;
            return {
              ...delivery,
              status: failure ? "error" : "ok",
              error: failure?.error,
              errorKind: failure?.errorKind,
            };
          },
        });
        try {
          await cron.start();
          const job = await cron.add({
            ...cronTestInput(),
            wakeMode: "now",
            delivery: { mode: "announce", channel: "telegram", to: "123" },
          });
          const scheduledAt = job.state.nextRunAtMs;
          now += FOUR_HOURS_MS;
          if (mode === "force") {
            await expect(cron.enqueueRun(job.id, mode)).resolves.toMatchObject({
              ok: true,
              enqueued: true,
            });
            await finished.promise;
            await cron.status();
          } else {
            await expect(cron.run(job.id, mode)).resolves.toMatchObject({ ok: true, ran: true });
          }
          expect(sendText).toHaveBeenCalledTimes(mode === "force" ? 1 : 0);
          expect(await finished.promise).toMatchObject({
            jobId: job.id,
            status: "ok",
            completionStatus: mode === "force" ? "succeeded" : "failed",
            deliveryStatus: mode === "force" ? "delivered" : "not-delivered",
          });
          if (mode === "force") {
            expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text }));
            expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(scheduledAt);
            expect(cron.getJob(job.id)?.state.lastDeliveryError).toBeUndefined();
          }
        } finally {
          cron.stop();
          restoreActivePluginRegistrySnapshot(registry);
        }
      },
    ),
);

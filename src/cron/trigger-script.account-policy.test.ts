import { expect, it, vi } from "vitest";
import * as configSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as plugins from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { bindCronJobAdmittedRun, clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { withCronStore } from "./store.worker.test-support.js";
import { createCronScriptRuntime } from "./trigger-script.js";
import type { CronStoredJob } from "./types.js";

it.each(["trigger", "payload"] as const)(
  "preserves creator account authority through real %s preparation and execution",
  async (entry) => {
    await withCronStore("cron-account-policy", async (state) => {
      const registrySnapshot = plugins.captureActivePluginRegistrySnapshot();
      try {
        const config: OpenClawConfig = {
          agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
          tools: { allow: ["message"] },
          channels: {
            telegram: {
              accounts: {
                work: { botToken: "synthetic-work-token" },
                disabled: { enabled: false, botToken: "synthetic-disabled-token" },
              },
            },
          },
        };
        configSnapshot.setRuntimeConfigSnapshot(config, config);
        const sendText = vi.fn(async (_params: { accountId?: string | null }) => ({
          channel: "telegram" as const,
          messageId: "sent-1",
        }));
        const registry = createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({
                id: "telegram",
                config: {
                  listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? {}),
                  resolveAccount: (cfg, accountId) =>
                    cfg.channels?.telegram?.accounts?.[accountId ?? "default"] ?? {},
                },
              }),
              messaging: { targetResolver: { looksLikeId: (value: string) => value === "123" } },
              actions: { describeMessageTool: () => ({ actions: ["send"] }) },
              outbound: {
                deliveryMode: "direct",
                resolveTarget: ({ to }: { to?: string }) => ({ ok: true, to: to ?? "123" }),
                sendText,
              },
            },
          },
        ]);
        plugins.setActivePluginRegistry(registry);
        const runtime = createCronScriptRuntime({ config, loadPluginRegistry: () => registry });
        const signal = new AbortController().signal;
        const invoke = async (accountId: string, channel?: string) => {
          const script = `await message({ action: "send", channel: "telegram", accountId: ${JSON.stringify(accountId)}, target: "123", message: "Scheduled report" }); return { fire: false };`;
          const jobId = `account-${entry}-${accountId}`;
          const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
          const ownerSessionKey = `agent:main:telegram:${accountId}:direct:123`;
          const job: CronStoredJob = makeCronJob({
            id: jobId,
            agentId: "main",
            payload:
              entry === "trigger"
                ? { kind: "agentTurn", message: "Collect the report", toolsAllow: ["message"] }
                : { kind: "script", script, toolsAllow: ["message"] },
            delivery: { mode: "none", channel: "slack", accountId: "delivery" },
            owner: { agentId: "main", sessionKey: ownerSessionKey, accountId },
            scheduledToolPolicy: {
              version: 1,
              mode: "account",
              ownerSessionKey,
              ownerAccountId: accountId,
            },
          });
          if (channel) {
            job.toolsAllowProvenance = {
              version: 1,
              source: "final-executable-surface",
              callerOrigin: { kind: "external", channel },
            };
          }
          const params = {
            occurrence: TEST_SCHEDULED_OCCURRENCE,
            job,
            script,
            state: null,
            abortSignal: signal,
            deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
            executionIdentity: {
              ingress: { kind: "schedule", boundary: "cron.script", state: "present" } as const,
              onPostAdmission: (admitted) => bindCronJobAdmittedRun(marker, admitted, signal),
            },
          } satisfies Parameters<typeof runtime.evaluateTrigger>[0];
          try {
            return await (entry === "trigger"
              ? runtime.evaluateTrigger(params)
              : runtime.executePayload(params));
          } finally {
            clearCronJobActive(jobId, marker);
          }
        };
        const expected =
          entry === "trigger" ? { kind: "evaluated", fire: false } : { kind: "completed" };
        for (const [accountId, channel, error, sends] of [
          ["work", "telegram", undefined, 1],
          ["work", "slack", 'Scheduled account "work" is unavailable', 1],
          ["work", undefined, 'Scheduled account "work" is unavailable', 1],
          ["work", "telegram", undefined, 2],
          ["missing", "telegram", 'Scheduled account "missing" is unavailable', 2],
          ["disabled", "telegram", "disabled", 2],
        ] as const) {
          const result = await invoke(accountId, channel);
          expect(result, JSON.stringify(result)).toMatchObject(
            error ? { kind: "error", error: expect.stringContaining(error) } : expected,
          );
          expect(sendText).toHaveBeenCalledTimes(sends);
          if (!error && sends === 1) {
            expect(sendText.mock.calls[0]?.[0]).toMatchObject({ accountId: "work" });
          }
        }
      } finally {
        configSnapshot.clearRuntimeConfigSnapshot();
        plugins.restoreActivePluginRegistrySnapshot(registrySnapshot);
      }
    });
  },
);

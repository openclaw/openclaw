import { expect, it, vi } from "vitest";
import type {
  ChannelMessageActionContext,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import * as configSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../gateway/agent-runtime-approval-authority.js";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import * as plugins from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { bindCronJobAdmittedRun, clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import type { CronScheduledToolCallerOrigin } from "./scheduled-tool-policy.js";
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

it("reuses hydrated creator origin for script admission across warm cache changes", async () => {
  await withCronStore("cron-script-delete-origin", async (state) => {
    const registrySnapshot = plugins.captureActivePluginRegistrySnapshot();
    try {
      const accountId = "account-a";
      const target = "123";
      const messageId = "message-a";
      const accounts = { [accountId]: { botToken: "synthetic-account-token" } };
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
        tools: { allow: ["message"] },
        channels: { telegram: { accounts } },
      };
      configSnapshot.setRuntimeConfigSnapshot(config, config);
      const handleAction = vi.fn(async (_context: ChannelMessageActionContext) => ({
        content: [{ type: "text" as const, text: "deleted" }],
        details: { ok: true },
      }));
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({
          id: "telegram",
          config: {
            listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? {}),
            resolveAccount: (cfg, selectedAccountId) =>
              cfg.channels?.telegram?.accounts?.[selectedAccountId ?? "default"] ?? {},
          },
        }),
        messaging: { targetResolver: { looksLikeId: (value) => value === target } },
        actions: {
          describeMessageTool: () => ({ actions: ["delete"] }),
          providerOwnedReadGates: ["delete"],
          writeAuthorityActions: ["delete"],
          handleAction,
        },
      };
      const owner = createTestPluginRegistry();
      const record = createPluginRecord({
        id: "cron-script-delete-provider",
        origin: "global",
        trustedOfficialInstall: true,
      });
      owner.registry.plugins.push(record);
      owner.createApi(record, { config, registrationMode: "full" }).registerChannel({ plugin });
      const registry = owner.registry;
      plugins.setActivePluginRegistry(registry);

      const script = `await message({ action: "delete", channel: "telegram", accountId: ${JSON.stringify(accountId)}, target: ${JSON.stringify(target)}, messageId: ${JSON.stringify(messageId)} }); return { ok: true };`;
      const controller = new AbortController();
      const ownerSessionKey = `agent:main:telegram:${accountId}:direct:${target}`;
      const { sendHandlers } = await import("../gateway/server-methods/send.js");
      const messageActionHandler = sendHandlers["message.action"];
      if (!messageActionHandler) {
        throw new Error("missing message.action Gateway handler");
      }
      const methods = createGatewayMethodRegistry([
        {
          name: "message.action",
          owner: { kind: "core", area: "message" },
          scope: "operator.write",
          handler: messageActionHandler,
        },
      ]);
      const gatewayContext = {
        getRuntimeConfig: () => config,
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
        getGatewayMethodRegistry: () => methods,
        trackExecution: <T>(run: () => Promise<T>) => run(),
        dedupe: new Map(),
      } as GatewayRequestContext;
      const runtime = createCronScriptRuntime({
        config,
        loadPluginRegistry: () => registry,
        resolveGatewayContext: () => gatewayContext,
      });
      const jobId = "script-delete-origin";
      const invoke = async (callerOrigin?: CronScheduledToolCallerOrigin) => {
        const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
        const job: CronStoredJob = makeCronJob({
          id: jobId,
          agentId: "main",
          payload: { kind: "script", script, toolsAllow: ["message"] },
          owner: { agentId: "main", sessionKey: ownerSessionKey, accountId },
          scheduledToolPolicy: {
            version: 1,
            mode: "account",
            ownerSessionKey,
            ownerAccountId: accountId,
          },
        });
        if (callerOrigin) {
          job.toolsAllowProvenance = {
            version: 1,
            source: "final-executable-surface",
            callerOrigin,
          };
        }
        try {
          return await runtime.executePayload({
            occurrence: TEST_SCHEDULED_OCCURRENCE,
            job,
            streamBatch: undefined,
            abortSignal: controller.signal,
            deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
            executionIdentity: {
              ingress: { kind: "schedule", boundary: "cron.script", state: "present" },
              onPostAdmission: (admitted) => {
                bindCronJobAdmittedRun(marker, admitted, controller.signal);
              },
            },
          });
        } finally {
          clearCronJobActive(jobId, marker);
        }
      };

      const validOrigin = { kind: "external", channel: "telegram" } as const;
      const first = await invoke(validOrigin);
      expect(first, JSON.stringify(first)).toMatchObject({ kind: "completed" });
      expect(handleAction).toHaveBeenCalledOnce();
      expect(handleAction.mock.calls[0]?.[0]).toMatchObject({
        action: "delete",
        channel: "telegram",
        accountId,
        params: { target: `telegram:${target}`, messageId },
      });

      for (const callerOrigin of [
        undefined,
        { kind: "unknown" },
        { kind: "external", channel: "slack" },
      ] as const) {
        const denied = await invoke(callerOrigin);
        expect(denied, JSON.stringify(denied)).toMatchObject({ kind: "error" });
        expect(denied.kind === "error" ? denied.error : "").toMatch(
          /Scheduled account "account-a" is unavailable|requires matching recorded creator origin/,
        );
        expect(handleAction).toHaveBeenCalledOnce();
      }

      const restored = await invoke(validOrigin);
      expect(restored, JSON.stringify(restored)).toMatchObject({ kind: "completed" });
      expect(handleAction).toHaveBeenCalledTimes(2);
    } finally {
      configSnapshot.clearRuntimeConfigSnapshot();
      plugins.restoreActivePluginRegistrySnapshot(registrySnapshot);
    }
  });
});

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { bindCronJobAdmittedRun, clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import type { CronScheduledToolCallerOrigin } from "./scheduled-tool-policy.js";
import { createCronScriptRuntime } from "./trigger-script.js";
import type { CronStoredJob } from "./types.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeAll(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-cron-account-policy-" });
  registrySnapshot = captureActivePluginRegistrySnapshot();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(registrySnapshot);
});

afterAll(async () => {
  await state.cleanup();
});

it.each(["trigger", "payload"] as const)(
  "preserves creator account authority through real %s preparation and execution",
  async (entry) => {
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
    setRuntimeConfigSnapshot(config, config);
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
    setActivePluginRegistry(registry);
    const runtime = createCronScriptRuntime({ config, loadPluginRegistry: () => registry });
    const controller = new AbortController();
    const invoke = async (accountId: string, callerOrigin?: CronScheduledToolCallerOrigin) => {
      const script = `await message({ action: "send", channel: "telegram", accountId: ${JSON.stringify(accountId)}, target: "123", message: "Scheduled report" }); return { fire: false };`;
      const jobId = `account-${entry}-${accountId}`;
      const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
      const ownerSessionKey = `agent:main:telegram:${accountId}:direct:123`;
      const job: CronStoredJob = {
        ...makeCronJob({
          id: jobId,
          agentId: "main",
          payload:
            entry === "trigger"
              ? { kind: "agentTurn", message: "Collect the report", toolsAllow: ["message"] }
              : { kind: "script", script, toolsAllow: ["message"] },
          delivery: { mode: "none", channel: "slack", accountId: "delivery" },
        }),
        owner: { agentId: "main", sessionKey: ownerSessionKey, accountId },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey,
          ownerAccountId: accountId,
        },
        ...(callerOrigin
          ? {
              toolsAllowProvenance: {
                version: 1,
                source: "final-executable-surface",
                callerOrigin,
              },
            }
          : {}),
      };
      const params = {
        job,
        script,
        state: null,
        abortSignal: controller.signal,
        deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "cron.script", state: "present" } as const,
          onPostAdmission: (admitted: AdmittedRunContext) => {
            bindCronJobAdmittedRun(marker, admitted, controller.signal);
          },
        },
      };
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
    const first = await invoke("work", { kind: "external", channel: "telegram" });
    expect(first, JSON.stringify(first)).toMatchObject(expected);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0]?.[0]).toMatchObject({ accountId: "work" });
    for (const origin of [{ kind: "external", channel: "slack" }, undefined] as const) {
      await expect(invoke("work", origin)).resolves.toMatchObject({
        kind: "error",
        error: expect.stringContaining('Scheduled account "work" is unavailable'),
      });
      expect(sendText).toHaveBeenCalledOnce();
    }
    await expect(invoke("work", { kind: "external", channel: "telegram" })).resolves.toMatchObject(
      expected,
    );
    expect(sendText).toHaveBeenCalledTimes(2);
    for (const [accountId, error] of [
      ["missing", 'Scheduled account "missing" is unavailable'],
      ["disabled", "disabled"],
    ] as const) {
      const rejected = await invoke(accountId, { kind: "external", channel: "telegram" });
      expect(rejected, JSON.stringify(rejected)).toMatchObject({
        kind: "error",
        error: expect.stringContaining(error),
      });
      expect(sendText).toHaveBeenCalledTimes(2);
    }
  },
);

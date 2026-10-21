import { expect, it, onTestFinished, vi } from "vitest";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { resolveToolSearchConfig } from "../agents/tool-search-config.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import * as configSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as plugins from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { bindCronJobAdmittedRun, clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import type { CronScheduledToolCallerOrigin } from "./scheduled-tool-policy.js";
import { createCronScriptRuntime } from "./trigger-script.js";
import { createCronScriptRuntimeFixture } from "./trigger-script.test-helpers.js";

async function messageFixture(accountPolicy = false) {
  const state = await createOpenClawTestState({ prefix: "openclaw-cron-script-message-" });
  const registrySnapshot = plugins.captureActivePluginRegistrySnapshot();
  onTestFinished(async () => {
    configSnapshot.clearRuntimeConfigSnapshot();
    plugins.restoreActivePluginRegistrySnapshot(registrySnapshot);
    await state.cleanup();
  });
  const accounts = {
    work: { botToken: "synthetic-work-token" },
    disabled: { enabled: false, botToken: "synthetic-disabled-token" },
  };
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
    tools: { allow: ["message"] },
    channels: {
      telegram: accountPolicy ? { accounts } : { enabled: true, botToken: "synthetic-cron-token" },
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
          ...(accountPolicy && {
            config: {
              listAccountIds: (cfg: OpenClawConfig) =>
                Object.keys(cfg.channels?.telegram?.accounts ?? {}),
              resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
                cfg.channels?.telegram?.accounts?.[accountId ?? "default"] ?? {},
            },
          }),
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
  return { config, registry, sendText };
}

it.each(["captured", "legacy"] as const)(
  "gates %s payload message delivery on its occurrence fence, including a warm invocation",
  async (policy) => {
    const { config, registry, sendText } = await messageFixture();
    const jobId = "script-message-payload";
    const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
    onTestFinished(() => clearCronJobActive(jobId, marker));
    const signal = new AbortController().signal;
    const beforeAttempt = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("occurrence delivery fence unavailable"));
    const runtime = createCronScriptRuntimeFixture({
      config,
      loadPluginRegistry: () => registry,
      runHeadless: async ({ ctx }) => {
        await new ToolSearchRuntime(ctx, resolveToolSearchConfig(config), {
          prepareInput: true,
          validateInput: true,
        }).callValue("message", {
          action: "send",
          channel: "telegram",
          target: "123",
          message: "Scheduled report",
        });
        return { status: "completed", value: { fire: false }, output: [], toolCallCount: 1 };
      },
    });
    const params: Parameters<typeof runtime.executePayload>[0] = {
      jobId,
      script: "return result",
      state: null,
      ...(policy === "captured"
        ? { toolsAllow: ["message"], scheduledToolPolicy: { version: 1, mode: "trusted" } }
        : {}),
      deliveryAttemptFence: { beforeAttempt, assertCurrent: () => {} },
      abortSignal: signal,
      executionIdentity: {
        ingress: { kind: "schedule", boundary: "cron.script", state: "present" },
        onPostAdmission: (admitted) => bindCronJobAdmittedRun(marker, admitted, signal),
      },
    };
    const invoke = () => runtime.executePayload(params);
    await expect(invoke()).resolves.toMatchObject({
      kind: "error",
      error: expect.stringContaining("occurrence delivery fence unavailable"),
    });
    expect([beforeAttempt.mock.calls.length, sendText.mock.calls.length]).toEqual([1, 0]);
    await expect(invoke()).resolves.toMatchObject({ kind: "completed" });
    expect([beforeAttempt.mock.calls.length, sendText.mock.calls.length]).toEqual([2, 1]);
  },
);

it.each(["trigger", "payload"] as const)(
  "preserves creator account authority through real %s preparation and execution",
  async (entry) => {
    const { config, registry, sendText } = await messageFixture(true);
    const runtime = createCronScriptRuntime({ config, loadPluginRegistry: () => registry });
    const signal = new AbortController().signal;
    const invoke = async (accountId: string, callerOrigin?: CronScheduledToolCallerOrigin) => {
      const script = `await message({ action: "send", channel: "telegram", accountId: ${JSON.stringify(accountId)}, target: "123", message: "Scheduled report" }); return { fire: false };`;
      const jobId = `account-${entry}-${accountId}`;
      const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
      const ownerSessionKey = `agent:main:telegram:${accountId}:direct:123`;
      const job = makeCronJob({
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
      if (callerOrigin) {
        job.toolsAllowProvenance = { version: 1, source: "final-executable-surface", callerOrigin };
      }
      const params = {
        job,
        script,
        state: null,
        abortSignal: signal,
        deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "cron.script", state: "present" } as const,
          onPostAdmission: (admitted: AdmittedRunContext) =>
            bindCronJobAdmittedRun(marker, admitted, signal),
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
    for (const [accountId, channel, error, sends] of [
      ["work", "telegram", undefined, 1],
      ["work", "slack", 'Scheduled account "work" is unavailable', 1],
      ["work", undefined, 'Scheduled account "work" is unavailable', 1],
      ["work", "telegram", undefined, 2],
      ["missing", "telegram", 'Scheduled account "missing" is unavailable', 2],
      ["disabled", "telegram", "disabled", 2],
    ] as const) {
      const result = await invoke(accountId, channel ? { kind: "external", channel } : undefined);
      expect(result, JSON.stringify(result)).toMatchObject(
        error ? { kind: "error", error: expect.stringContaining(error) } : expected,
      );
      expect(sendText).toHaveBeenCalledTimes(sends);
      if (!error && sends === 1) {
        expect(sendText.mock.calls[0]?.[0]).toMatchObject({ accountId: "work" });
      }
    }
  },
);

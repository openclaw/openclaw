import { expect, it, onTestFinished, vi } from "vitest";
import { resolveToolSearchConfig } from "../agents/tool-search-config.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import * as configSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as plugins from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { bindCronJobAdmittedRun, clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { createCronScriptRuntimeFixture } from "./trigger-script.test-helpers.js";

it.each(["captured", "legacy"] as const)(
  "gates %s payload message delivery on its occurrence fence, including a warm invocation",
  async (policy) => {
    const state = await createOpenClawTestState({ prefix: "openclaw-cron-script-message-" });
    const registrySnapshot = plugins.captureActivePluginRegistrySnapshot();
    onTestFinished(async () => {
      configSnapshot.clearRuntimeConfigSnapshot();
      plugins.restoreActivePluginRegistrySnapshot(registrySnapshot);
      await state.cleanup();
    });
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
      tools: { allow: ["message"] },
      channels: { telegram: { enabled: true, botToken: "synthetic-cron-token" } },
    };
    configSnapshot.setRuntimeConfigSnapshot(config, config);
    const sendText = vi.fn(async () => ({ channel: "telegram" as const, messageId: "sent-1" }));
    const registry = createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram" }),
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

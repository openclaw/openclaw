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
import { createCronScriptRuntimeFixture } from "./trigger-script.test-helpers.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeAll(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-cron-script-message-" });
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
  "allows %s messages only while the scheduled occurrence owns authority",
  async (mode) => {
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
      tools: { allow: ["message"] },
      channels: { telegram: { enabled: true, botToken: "synthetic-cron-token" } },
    };
    setRuntimeConfigSnapshot(config, config);
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
    setActivePluginRegistry(registry);
    const jobId = `script-message-${mode}`;
    let authorityCurrent = true;
    const marker = markCronJobActive(jobId, {
      isMessageActionAuthorityCurrent: () => authorityCurrent,
    });
    const controller = new AbortController();
    const runtime = createCronScriptRuntimeFixture({
      config,
      loadPluginRegistry: () => registry,
    });
    const params = {
      jobId,
      script:
        'await message({ action: "send", channel: "telegram", target: "123", message: "Scheduled report" }); return { fire: false };',
      state: null,
      toolsAllow: ["message"],
      scheduledToolPolicy: { version: 1, mode: "trusted" } as const,
      abortSignal: controller.signal,
      executionIdentity: {
        ingress: { kind: "schedule", boundary: "cron.script", state: "present" } as const,
        onPostAdmission: (admitted: AdmittedRunContext) => {
          bindCronJobAdmittedRun(marker, admitted, controller.signal);
        },
      },
    };
    const invoke = () =>
      mode === "trigger" ? runtime.evaluateTrigger(params) : runtime.executePayload(params);
    try {
      await expect(invoke()).resolves.toMatchObject({
        kind: mode === "trigger" ? "evaluated" : "completed",
      });
      expect(sendText).toHaveBeenCalledOnce();
      authorityCurrent = false;
      await expect(invoke()).resolves.toMatchObject({
        kind: "error",
        error: expect.stringContaining("cron message action authority is no longer active"),
      });
      expect(sendText).toHaveBeenCalledOnce();
    } finally {
      clearCronJobActive(jobId, marker);
    }
  },
);

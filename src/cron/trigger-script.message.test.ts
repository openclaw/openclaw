import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { resolveToolSearchConfig } from "../agents/tool-search-config.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
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

it.each(
  (["captured", "legacy"] as const).flatMap((policy) =>
    (["trigger", "payload"] as const).map((mode) => ({ policy, mode })),
  ),
)(
  "gates $policy $mode message delivery on its occurrence fence, including a warm invocation",
  async ({ policy, mode }) => {
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
    const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
    const controller = new AbortController();
    let rejectDelivery = true;
    const beforeAttempt = vi.fn(async () => {
      if (rejectDelivery) {
        throw new Error("occurrence delivery fence unavailable");
      }
    });
    const runtime = createCronScriptRuntimeFixture({
      config,
      loadPluginRegistry: () => registry,
      runHeadless: async ({ ctx }) => {
        const tools = new ToolSearchRuntime(ctx, resolveToolSearchConfig(config), {
          prepareInput: true,
          validateInput: true,
        });
        await tools.callValue("message", {
          action: "send",
          channel: "telegram",
          target: "123",
          message: "Scheduled report",
        });
        return { status: "completed", value: { fire: false }, output: [], toolCallCount: 1 };
      },
    });
    const params = {
      jobId,
      script: "return result",
      state: null,
      ...(policy === "captured"
        ? { toolsAllow: ["message"], scheduledToolPolicy: { version: 1, mode: "trusted" } as const }
        : {}),
      deliveryAttemptFence: { occurrenceAtMs: 0, beforeAttempt, assertCurrent: () => {} },
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
        kind: "error",
        error: expect.stringContaining("occurrence delivery fence unavailable"),
      });
      expect(beforeAttempt).toHaveBeenCalledOnce();
      expect(sendText).not.toHaveBeenCalled();
      rejectDelivery = false;
      await expect(invoke()).resolves.toMatchObject({
        kind: mode === "trigger" ? "evaluated" : "completed",
      });
      expect(beforeAttempt).toHaveBeenCalledTimes(2);
      expect(sendText).toHaveBeenCalledOnce();
    } finally {
      clearCronJobActive(jobId, marker);
    }
  },
);

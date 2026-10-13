import { expect, it, onTestFinished, vi } from "vitest";
import { CodeModeHeadlessAbortError } from "../agents/code-mode-errors.js";
import { resolveToolSearchConfig } from "../agents/tool-search-config.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import {
  inspectTurnSendLedger,
  resetTurnSendLedgerForTest,
} from "../agents/tools/turn-send-ledger.js";
import * as configSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as plugins from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { bindCronJobAdmittedRun, clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { createCronScriptRuntimeFixture } from "./trigger-script.test-helpers.js";

// Sends one telegram message through the real message tool from a cron script payload.
async function prepareMessageScript(params: {
  jobId: string;
  policy: "captured" | "legacy";
  rejectFirstDelivery: boolean;
  afterSend?: (controller: AbortController) => void;
}) {
  const state = await createOpenClawTestState({ prefix: "openclaw-cron-script-message-" });
  const registrySnapshot = plugins.captureActivePluginRegistrySnapshot();
  onTestFinished(async () => {
    configSnapshot.clearRuntimeConfigSnapshot();
    plugins.restoreActivePluginRegistrySnapshot(registrySnapshot);
    resetTurnSendLedgerForTest();
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
  const marker = markCronJobActive(params.jobId, { isMessageActionAuthorityCurrent: () => true });
  onTestFinished(() => clearCronJobActive(params.jobId, marker));
  const controller = new AbortController();
  const beforeAttempt = vi.fn(async () => {});
  if (params.rejectFirstDelivery) {
    beforeAttempt.mockRejectedValueOnce(new Error("occurrence delivery fence unavailable"));
  }
  // Ledger slots live while the script runs; sampled right after the send.
  const liveLedgerSlots: number[] = [];
  const runtime = createCronScriptRuntimeFixture({
    config,
    loadPluginRegistry: () => registry,
    runHeadless: async ({ ctx }) => {
      try {
        await new ToolSearchRuntime(ctx, resolveToolSearchConfig(config), {
          prepareInput: true,
          validateInput: true,
        }).callValue("message", {
          action: "send",
          channel: "telegram",
          target: "123",
          message: "Scheduled report",
        });
      } finally {
        liveLedgerSlots.push(inspectTurnSendLedger().length);
      }
      params.afterSend?.(controller);
      return { status: "completed", value: { fire: false }, output: [], toolCallCount: 1 };
    },
  });
  const invocation: Parameters<typeof runtime.executePayload>[0] = {
    jobId: params.jobId,
    script: "return result",
    state: null,
    ...(params.policy === "captured"
      ? { toolsAllow: ["message"], scheduledToolPolicy: { version: 1, mode: "trusted" } }
      : {}),
    deliveryAttemptFence: { beforeAttempt, assertCurrent: () => {} },
    abortSignal: controller.signal,
    executionIdentity: {
      ingress: { kind: "schedule", boundary: "cron.script", state: "present" },
      onPostAdmission: (admitted) => bindCronJobAdmittedRun(marker, admitted, controller.signal),
    },
  };
  return {
    invoke: () => runtime.executePayload(invocation),
    sendText,
    beforeAttempt,
    liveLedgerSlots,
  };
}

it.each(["captured", "legacy"] as const)(
  "gates %s payload message delivery on its occurrence fence, including a warm invocation",
  async (policy) => {
    const script = await prepareMessageScript({
      jobId: "script-message-payload",
      policy,
      rejectFirstDelivery: true,
    });
    await expect(script.invoke()).resolves.toMatchObject({
      kind: "error",
      error: expect.stringContaining("occurrence delivery fence unavailable"),
    });
    expect([script.beforeAttempt.mock.calls.length, script.sendText.mock.calls.length]).toEqual([
      1, 0,
    ]);
    await expect(script.invoke()).resolves.toMatchObject({ kind: "completed" });
    expect([script.beforeAttempt.mock.calls.length, script.sendText.mock.calls.length]).toEqual([
      2, 1,
    ]);
    // Each evaluation mints its own runId and owns that ledger slot: a failed and a
    // delivered send both held one while the script ran, and neither outlives it.
    expect(script.liveLedgerSlots).toEqual([1, 1]);
    expect(inspectTurnSendLedger()).toEqual([]);
  },
);

it("clears the evaluation's send ledger slot when the script is cancelled", async () => {
  const script = await prepareMessageScript({
    jobId: "script-message-cancelled",
    policy: "captured",
    rejectFirstDelivery: false,
    afterSend: (controller) => {
      controller.abort();
      throw new CodeModeHeadlessAbortError("cron script cancelled");
    },
  });
  await expect(script.invoke()).resolves.toMatchObject({ kind: "error", code: "aborted" });
  expect(script.sendText).toHaveBeenCalledOnce();
  expect(script.liveLedgerSlots).toEqual([1]);
  expect(inspectTurnSendLedger()).toEqual([]);
});

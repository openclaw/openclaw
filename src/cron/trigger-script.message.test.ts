import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { CodeModeHeadlessAbortError } from "../agents/code-mode-errors.js";
import { resolveToolSearchConfig } from "../agents/tool-search-config.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import {
  inspectTurnSendLedger,
  resetTurnSendLedgerForTest,
} from "../agents/tools/turn-send-ledger.js";
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
  resetTurnSendLedgerForTest();
});

afterAll(async () => {
  await state.cleanup();
});

type RunHeadless = NonNullable<Parameters<typeof createCronScriptRuntimeFixture>[0]["runHeadless"]>;

// Sends one telegram message through the real message tool from a cron script payload.
function prepareMessageScript(params: {
  jobId: string;
  policy: "captured" | "legacy";
  afterSend?: (controller: AbortController) => void;
}) {
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
  const marker = markCronJobActive(params.jobId, { isMessageActionAuthorityCurrent: () => true });
  const controller = new AbortController();
  const delivery = { reject: true };
  const beforeAttempt = vi.fn(async () => {
    if (delivery.reject) {
      throw new Error("occurrence delivery fence unavailable");
    }
  });
  // Ledger slots live while the script runs; sampled right after the send.
  const liveLedgerSlots: number[] = [];
  const runHeadless: RunHeadless = async ({ ctx }) => {
    const tools = new ToolSearchRuntime(ctx, resolveToolSearchConfig(config), {
      prepareInput: true,
      validateInput: true,
    });
    try {
      await tools.callValue("message", {
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
  };
  const runtime = createCronScriptRuntimeFixture({
    config,
    loadPluginRegistry: () => registry,
    runHeadless,
  });
  const invocation = {
    jobId: params.jobId,
    script: "return result",
    state: null,
    ...(params.policy === "captured"
      ? { toolsAllow: ["message"], scheduledToolPolicy: { version: 1, mode: "trusted" } as const }
      : {}),
    deliveryAttemptFence: { beforeAttempt, assertCurrent: () => {} },
    abortSignal: controller.signal,
    executionIdentity: {
      ingress: { kind: "schedule", boundary: "cron.script", state: "present" } as const,
      onPostAdmission: (admitted: AdmittedRunContext) => {
        bindCronJobAdmittedRun(marker, admitted, controller.signal);
      },
    },
  };
  return {
    invoke: () => runtime.executePayload(invocation),
    sendText,
    beforeAttempt,
    delivery,
    liveLedgerSlots,
    dispose: () => clearCronJobActive(params.jobId, marker),
  };
}

it.each(["captured", "legacy"] as const)(
  "gates %s payload message delivery on its occurrence fence, including a warm invocation",
  async (policy) => {
    const script = prepareMessageScript({ jobId: "script-message-payload", policy });
    try {
      await expect(script.invoke()).resolves.toMatchObject({
        kind: "error",
        error: expect.stringContaining("occurrence delivery fence unavailable"),
      });
      expect(script.beforeAttempt).toHaveBeenCalledOnce();
      expect(script.sendText).not.toHaveBeenCalled();
      script.delivery.reject = false;
      await expect(script.invoke()).resolves.toMatchObject({
        kind: "completed",
      });
      expect(script.beforeAttempt).toHaveBeenCalledTimes(2);
      expect(script.sendText).toHaveBeenCalledOnce();
      // Each evaluation mints its own runId and owns that ledger slot: a failed and a
      // delivered send both held one while the script ran, and neither outlives it.
      expect(script.liveLedgerSlots).toEqual([1, 1]);
      expect(inspectTurnSendLedger()).toEqual([]);
    } finally {
      script.dispose();
    }
  },
);

it("clears the evaluation's send ledger slot when the script is cancelled", async () => {
  const script = prepareMessageScript({
    jobId: "script-message-cancelled",
    policy: "captured",
    afterSend: (controller) => {
      controller.abort();
      throw new CodeModeHeadlessAbortError("cron script cancelled");
    },
  });
  script.delivery.reject = false;
  try {
    await expect(script.invoke()).resolves.toMatchObject({ kind: "error", code: "aborted" });
    expect(script.sendText).toHaveBeenCalledOnce();
    expect(script.liveLedgerSlots).toEqual([1]);
    expect(inspectTurnSendLedger()).toEqual([]);
  } finally {
    script.dispose();
  }
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { resolveEmbeddedRunAttemptTerminalState } from "../../agents/embedded-agent-runner/run/terminal-outcome.js";
import { resolveSettledTurnFinalizationRequest } from "../../agents/embedded-agent-runner/run/terminal-resolution.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

const mocks = vi.hoisted(() => ({
  authorityActive: true,
  close: vi.fn(),
  createOperationalRunInstanceRef: vi.fn((runId: string) => ({
    instanceId: `instance:${runId}`,
    runId,
  })),
  getRuntimeConfig: vi.fn(() => ({}) as OpenClawConfig),
  prepareAgentRunAdmission: vi.fn(),
  runEmbeddedAgentCore: vi.fn(),
}));

vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority: vi.fn(() =>
    mocks.authorityActive ? { runId: "run-plugin" } : undefined,
  ),
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));

import { runPluginEmbeddedAgent } from "./runtime-embedded-agent.runtime.js";

const config = {} as OpenClawConfig;
const params = {
  config,
  prompt: "check",
  runId: "run-plugin",
  sessionId: "session-plugin",
  sessionTarget: {
    agentId: "researcher",
    sessionId: "session-plugin",
    sessionKey: "agent:researcher:plugin",
    storePath: "/tmp/sessions",
  },
  timeoutMs: 1,
  workspaceDir: "/tmp/workspace",
} as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

describe("plugin embedded-agent runtime admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorityActive = true;
    mocks.close.mockImplementation(() => {
      mocks.authorityActive = false;
    });
    mocks.prepareAgentRunAdmission.mockReturnValue({
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      admit: vi.fn(),
      close: mocks.close,
    });
    mocks.runEmbeddedAgentCore.mockResolvedValue({ payloads: [] });
  });

  it.each(["explicit", "runtime"] as const)(
    "shares %s config between admission and execution and closes admission",
    async (configSource) => {
      const runParams = configSource === "explicit" ? params : { ...params, config: undefined };
      if (configSource === "runtime") {
        mocks.getRuntimeConfig.mockReturnValueOnce(config);
      }
      await expect(
        withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
          runPluginEmbeddedAgent(runParams),
        ),
      ).resolves.toEqual({ payloads: [] });

      expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledWith({
        cfg: config,
        operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
        facts: {
          runId: "run-plugin",
          agentId: "researcher",
          ingress: {
            kind: "plugin",
            boundary: "plugin-runtime",
            rawSourceRef: "memory-plugin",
            state: "present",
          },
        },
        onAdmitted: expect.any(Function),
      });
      expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
        expect.objectContaining({
          ...params,
          preparedRunAdmission: expect.objectContaining({ close: mocks.close }),
        }),
      );
      expect(mocks.getRuntimeConfig).toHaveBeenCalledTimes(configSource === "runtime" ? 1 : 0);
      expect(mocks.close).toHaveBeenCalledOnce();
    },
  );

  it("closes the prepared admission when core execution throws", async () => {
    mocks.runEmbeddedAgentCore.mockRejectedValueOnce(new Error("core failed"));

    await expect(
      withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent(params),
      ),
    ).rejects.toThrow("core failed");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([true, false])("ignores the shipped GitHub availability input %s", async (available) => {
    await expect(
      withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent({ ...params, githubPublicationAvailable: available }),
      ),
    ).resolves.toEqual({ payloads: [] });
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce();
    expect(mocks.runEmbeddedAgentCore.mock.calls[0]![0]).not.toHaveProperty(
      "githubPublicationAvailable",
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each(["legacy-send", "legacy-send-then-throw", "collector", "no-send"] as const)(
    "keeps %s ownership across a required NO_REPLY after settled tools",
    async (owner) => {
      const delivered: string[] = [];
      const collected: string[] = [];
      const callerOwnsDelivery = owner === "legacy-send" || owner === "legacy-send-then-throw";
      const callbackRejects = owner === "legacy-send-then-throw" || owner === "no-send";
      const assistant = buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "NO_REPLY" }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        toolMetas: [{ toolName: "write", isError: false, replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
      let finalizationRequest: string | null = null;
      mocks.runEmbeddedAgentCore.mockImplementationOnce(
        async (input: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]) => {
          const blockReply = Promise.resolve().then(() =>
            input.onBlockReply?.({ text: "The note is saved." }, { assistantMessageIndex: 1 }),
          );
          if (callbackRejects) {
            await expect(blockReply).rejects.toThrow("transport callback rejected");
          } else {
            await blockReply;
          }
          const replyDeliveryState = (await input.resolveReplyDelivery?.(0)) ?? "missing";
          expect(replyDeliveryState).toBe(callerOwnsDelivery ? "pending" : "missing");
          finalizationRequest = resolveSettledTurnFinalizationRequest({
            runParams: input,
            attempt,
            activeErrorContext: { provider: "openai", model: "gpt-4.1-mini" },
            modelApi: "openai-responses",
            executionContract: undefined,
            payloadsWithToolMedia: [],
            hasTerminalToolPresentation: false,
            terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
            settledTurnFinalizationAvailable: true,
            replyDeliveryState,
          });
          return { payloads: finalizationRequest ? [{ text: "Recovered tool summary." }] : [] };
        },
      );

      const result = await withPluginRuntimePluginScope({ pluginId: "reply-plugin" }, () =>
        runPluginEmbeddedAgent({
          ...params,
          terminalReplyExpectation: "required",
          ...(!callerOwnsDelivery ? { resolveReplyDelivery: async () => "missing" as const } : {}),
          onBlockReply: ({ text }) => {
            if (text && owner !== "no-send") {
              (callerOwnsDelivery ? delivered : collected).push(text);
            }
            if (callbackRejects) {
              throw new Error("transport callback rejected");
            }
          },
        }),
      );
      for (const payload of result.payloads ?? []) {
        if (payload.text) {
          delivered.push(payload.text);
        }
      }
      expect(delivered).toEqual([
        callerOwnsDelivery ? "The note is saved." : "Recovered tool summary.",
      ]);
      if (callerOwnsDelivery) {
        expect(finalizationRequest).toBeNull();
      } else {
        expect(collected).toEqual(owner === "collector" ? ["The note is saved."] : []);
        expect(finalizationRequest).toEqual(expect.any(String));
      }
    },
  );

  it("does not turn previews, commentary, reasoning, or progress into final custody", async () => {
    mocks.runEmbeddedAgentCore.mockImplementationOnce(
      async (input: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]) => {
        await input.onPartialReply?.({ text: "Preview answer" });
        await input.onToolResult?.({ text: "Tool progress" });
        for (const payload of [
          { text: "Thinking", isReasoning: true },
          { text: "Working", isCommentary: true },
          { text: "Compacting", isCompactionNotice: true },
          { text: "Progress", channelData: { openclawProgressKind: "fast-mode-auto" } },
          { text: " " },
        ]) {
          await input.onBlockReply?.(payload, { assistantMessageIndex: 1 });
        }
        expect(await input.resolveReplyDelivery?.(0)).toBe("missing");
        return { payloads: [] };
      },
    );
    await withPluginRuntimePluginScope({ pluginId: "reply-plugin" }, () =>
      runPluginEmbeddedAgent({
        ...params,
        onBlockReply: () => {},
        onPartialReply: () => {},
        onToolResult: () => {},
      }),
    );
  });

  it("retains unindexed legacy custody only for the initial input", async () => {
    mocks.runEmbeddedAgentCore.mockImplementationOnce(
      async (input: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]) => {
        await input.onBlockReply?.({ text: "First answer" });
        expect(await input.resolveReplyDelivery?.(0)).toBe("pending");
        expect(await input.resolveReplyDelivery?.(1)).toBe("missing");
        await input.onBlockReply?.({ text: "Unscoped late answer" });
        expect(await input.resolveReplyDelivery?.(0)).toBe("missing");
        await input.onBlockReply?.(
          setReplyPayloadMetadata(
            { mediaUrls: ["https://example.com/answer.png"] },
            {
              assistantMessageIndex: 2,
            },
          ),
        );
        expect(await input.resolveReplyDelivery?.(1)).toBe("pending");
        return { payloads: [] };
      },
    );
    await withPluginRuntimePluginScope({ pluginId: "reply-plugin" }, () =>
      runPluginEmbeddedAgent({ ...params, onBlockReply: () => {} }),
    );
  });

  it("does not restore earlier-input custody when an old callback resolves late", async () => {
    const accepted = createDeferred();
    mocks.runEmbeddedAgentCore.mockImplementationOnce(
      async (input: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]) => {
        const oldReply = input.onBlockReply?.({ text: "Old answer" }, { assistantMessageIndex: 1 });
        expect(await input.resolveReplyDelivery?.(2)).toBe("missing");
        accepted.resolve();
        await oldReply;
        expect(await input.resolveReplyDelivery?.(2)).toBe("missing");
        await input.onBlockReply?.({ text: "Current answer" }, { assistantMessageIndex: 2 });
        expect(await input.resolveReplyDelivery?.(2)).toBe("pending");
        expect(await input.resolveReplyDelivery?.(3)).toBe("missing");
        expect(await input.resolveReplyDelivery?.(0)).toBe("missing");
        return { payloads: [] };
      },
    );
    await withPluginRuntimePluginScope({ pluginId: "reply-plugin" }, () =>
      runPluginEmbeddedAgent({ ...params, onBlockReply: () => accepted.promise }),
    );
  });

  it("retains uncertain custody while a callback is pending and after it rejects", async () => {
    const callback = createDeferred();
    mocks.runEmbeddedAgentCore.mockImplementationOnce(
      async (input: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]) => {
        const pending = input.onBlockReply?.(
          { text: "Uncertain answer" },
          { assistantMessageIndex: 1 },
        );
        expect(await input.resolveReplyDelivery?.(0)).toBe("pending");
        callback.reject(new Error("transport callback rejected"));
        await expect(pending).rejects.toThrow("transport callback rejected");
        expect(await input.resolveReplyDelivery?.(0)).toBe("pending");
        return { payloads: [] };
      },
    );
    await withPluginRuntimePluginScope({ pluginId: "reply-plugin" }, () =>
      runPluginEmbeddedAgent({ ...params, onBlockReply: () => callback.promise }),
    );
  });

  it.each(["abort", "completion"] as const)("retires legacy custody on %s", async (end) => {
    const controller = new AbortController();
    const accepted = createDeferred();
    let observe: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]["resolveReplyDelivery"];
    mocks.runEmbeddedAgentCore.mockImplementationOnce(
      async (input: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]) => {
        observe = input.resolveReplyDelivery;
        await input.onBlockReply?.({ text: "Accepted answer" }, { assistantMessageIndex: 1 });
        expect(await observe?.(0)).toBe("pending");
        if (end === "abort") {
          const lateReply = input.onBlockReply?.(
            { text: "Late answer" },
            { assistantMessageIndex: 2 },
          );
          controller.abort();
          expect(await observe?.(0)).toBe("missing");
          accepted.resolve();
          await lateReply;
          expect(await observe?.(0)).toBe("missing");
        }
        return { payloads: [] };
      },
    );
    await withPluginRuntimePluginScope({ pluginId: "reply-plugin" }, () =>
      runPluginEmbeddedAgent({
        ...params,
        abortSignal: controller.signal,
        onBlockReply: ({ text }) => (text === "Late answer" ? accepted.promise : undefined),
      }),
    );
    expect(await observe?.(0)).toBe("missing");
  });

  it("records exact admission and attribution-only completion without plugin identifiers", async () => {
    const executionIdentityToken = {
      tokenVersion: 1,
      contextId: "context-plugin",
      executionId: "execution-plugin",
      runId: "run-plugin",
      createdAt: 100,
    } as const;
    const admittedRunContext: AdmittedRunContext = {
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      executionIdentityToken,
    };
    mocks.prepareAgentRunAdmission.mockImplementationOnce(
      (input: { onAdmitted?: (context: AdmittedRunContext) => void | Promise<void> }) => ({
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        admit: async () => {
          await input.onAdmitted?.(admittedRunContext);
          return admittedRunContext;
        },
        close: mocks.close,
      }),
    );
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async (input) => {
      await input.preparedRunAdmission.admit("plugin-harness");
      return { payloads: [] };
    });
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    try {
      await withPluginRuntimePluginScope({ pluginId: "private-plugin-id" }, () =>
        runPluginEmbeddedAgent(params),
      );
    } finally {
      clear();
    }
    expect(receipts).toMatchObject([
      {
        decision: { outcome: "allowed", reasonCode: "plugin_runtime_owner_admitted" },
        enforcement: { coverageState: "enforced" },
      },
      {
        decision: { outcome: "allowed", reasonCode: "plugin_runtime_completed" },
        enforcement: { coverageState: "attribution-only" },
      },
    ]);
    expect(JSON.stringify(receipts)).not.toContain("private-plugin-id");
  });

  it("admits a plugin run deferred until after its triggering command root released", async () => {
    const triggeringRoot = tryBeginGatewayRootWorkAdmission("command:new");
    expect(triggeringRoot).not.toBeNull();
    let admissionClosedDuringRun: boolean | undefined;
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      admissionClosedDuringRun = isGatewaySubordinateWorkAdmissionClosed();
      return { payloads: [] };
    });

    let continueRun = () => {};
    const gate = new Promise<void>((resolve) => {
      continueRun = resolve;
    });
    let runResult: Promise<unknown> | undefined;
    // Mirrors the real bug: a hook callback registered during the triggering
    // command fires only after that command's root work is released, but
    // still inherits the released root via Node's automatic AsyncLocalStorage
    // propagation rather than a lexical reference to it.
    await triggeringRoot?.run(async () => {
      runResult = withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, async () => {
        await gate;
        return runPluginEmbeddedAgent(params);
      });
    });

    triggeringRoot?.release();
    continueRun();

    await expect(runResult).resolves.toEqual({ payloads: [] });
    expect(admissionClosedDuringRun).toBe(false);
  });

  it("keeps a live parent's plugin run admitted across a reversible suspension", async () => {
    const parentRoot = tryBeginGatewayRootWorkAdmission("command:new");
    expect(parentRoot).not.toBeNull();
    let runResult: Promise<unknown> | undefined;
    await parentRoot?.run(async () => {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension).not.toBeNull();
      runResult = withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent(params),
      );
      // A live parent keeps its right to finish subordinate work across a
      // reversible suspension: admission must be reserved synchronously here,
      // not parked behind the closed global fence like a fresh root.
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      suspension?.rollback();
    });

    await expect(runResult).resolves.toEqual({ payloads: [] });
    parentRoot?.release();
  });

  it("rejects a deferred plugin run's admission wait on abort instead of waiting for admission to reopen", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    const controller = new AbortController();
    // No live parent root: this run owns the closed-admission wait itself, so
    // its abort must settle that wait instead of only being checked afterward.
    const run = withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
      runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
    );
    controller.abort(new Error("cancelled while waiting for admission"));

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
    suspension?.rollback();
  });

  it("revokes admission immediately when a pending plugin run aborts", async () => {
    const core = createDeferred<{ payloads: never[] }>();
    const admittedRunContext: AdmittedRunContext = {
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      executionIdentityToken: {
        tokenVersion: 1,
        contextId: "context-plugin-abort",
        executionId: "execution-plugin-abort",
        runId: "run-plugin",
        createdAt: 100,
      },
    };
    mocks.prepareAgentRunAdmission.mockImplementationOnce(
      (input: { onAdmitted?: (context: AdmittedRunContext) => void | Promise<void> }) => ({
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        admit: async () => {
          await input.onAdmitted?.(admittedRunContext);
          return admittedRunContext;
        },
        close: mocks.close,
      }),
    );
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async (input) => {
      await input.preparedRunAdmission.admit("plugin-harness");
      return core.promise;
    });
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    const controller = new AbortController();
    const run = withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
      runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
    );
    try {
      await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());

      controller.abort(new Error("cancelled"));
      expect(mocks.close).toHaveBeenCalledOnce();
      core.resolve({ payloads: [] });
      await expect(run).resolves.toEqual({ payloads: [] });
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(receipts.map((receipt) => receipt.decision.reasonCode)).toEqual([
        "plugin_runtime_owner_admitted",
      ]);
    } finally {
      clear();
    }
  });

  it("closes admission when abort races with listener registration", async () => {
    const controller = new AbortController();
    mocks.prepareAgentRunAdmission.mockImplementationOnce(() => {
      controller.abort(new Error("raced cancellation"));
      return {
        operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
        admit: vi.fn(),
        close: mocks.close,
      };
    });

    await expect(
      withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
      ),
    ).rejects.toThrow("raced cancellation");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("does not create admission for an already-aborted plugin run", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    await expect(
      withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
      ),
    ).rejects.toThrow("already cancelled");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("fails closed outside a plugin scope", async () => {
    await expect(runPluginEmbeddedAgent(params)).rejects.toThrow("active plugin runtime scope");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it.each([
    "admittedRunContext",
    "preparedRunAdmission",
    "onDeferredLifecycleOwner",
    "onDeferredLifecycleAbort",
    "onRetryWait",
    "compactionCountOwner",
    "onCompactionAccounting",
    "onContextAccountingEvent",
  ] as const)("rejects a plugin-supplied %s", async (field) => {
    const value = field === "compactionCountOwner" ? "caller" : {};
    const input = { ...params, [field]: value };
    await expect(
      withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent(input),
      ),
    ).rejects.toThrow("cannot supply host run authority");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it.each(["compactionCountOwner", "onCompactionAccounting", "onContextAccountingEvent"])(
    "rejects inherited %s before admission",
    async (field) => {
      const input = { ...params };
      Object.setPrototypeOf(input, {
        [field]: field === "compactionCountOwner" ? "caller" : vi.fn(),
      });

      await expect(
        withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
          runPluginEmbeddedAgent(input),
        ),
      ).rejects.toThrow("cannot supply host run authority");
      expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
    },
  );
});

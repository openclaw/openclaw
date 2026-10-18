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
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
  resolveMemoryAudienceFromEntry,
} from "../memory-audience.js";
import { fakeSessionOwner } from "../memory-audience.test-support.js";
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
vi.mock("../../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } = await import("../memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
vi.mock("../../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } = await import("../memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});

async function parentAudience(agentId: string) {
  const sessionKey = `agent:${agentId}:parent`;
  const entry = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    updatedAt: 1,
    chatType: "direct" as const,
  };
  fakeSessionOwner.rows.set(sessionKey, entry);
  const resolution = await resolveMemoryAudienceFromEntry(
    {
      agentId,
      sessionKey,
      sessionId: entry.sessionId,
      senderIsOwner: true,
      storePath: "/tmp/sessions",
    },
    entry,
  );
  if (resolution.status !== "granted") {
    throw new Error(resolution.reason);
  }
  return resolution.audience;
}

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
      const runParams = {
        ...params,
        config: configSource === "explicit" ? config : undefined,
        githubPublicationAvailable: configSource === "explicit",
      };
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
      expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce();
      expect(mocks.runEmbeddedAgentCore.mock.calls[0]![0]).not.toHaveProperty(
        "githubPublicationAvailable",
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

  it("delegates the parent audience to the child session before core execution", async () => {
    const audience = await parentAudience("researcher");
    fakeSessionOwner.rows.set("agent:researcher:plugin", {
      sessionId: "session-plugin",
      updatedAt: 1,
    });
    await withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
      runPluginEmbeddedAgent({ ...params, memoryAudience: audience }),
    );
    const childAudience = mocks.runEmbeddedAgentCore.mock.calls[0]![0].memoryAudience;
    expect(childAudience).toEqual(audience);
    expect(childAudience).not.toBe(audience);
    expect(() =>
      assertMemoryAudienceSession(childAudience, params.sessionTarget!.sessionKey),
    ).not.toThrow();
    expect(() => assertMemoryAudienceSession(childAudience, "agent:researcher:parent")).toThrow(
      "different session",
    );
    // The run releases its delegated grant when it ends.
    expect(() => assertMemoryAudienceCurrent(childAudience)).toThrow("released by its owner");
    expect(() => assertMemoryAudienceCurrent(audience)).not.toThrow();
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

  it.each(["completion", "abort"] as const)(
    "records admission and closes authority on %s without leaking plugin identifiers",
    async (end) => {
      const core = createDeferred<{ payloads: never[] }>();
      const started = createDeferred();
      const admittedRunContext: AdmittedRunContext = {
        operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
        executionIdentityToken: {
          tokenVersion: 1,
          contextId: "context-plugin",
          executionId: "execution-plugin",
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
        started.resolve();
        return core.promise;
      });
      const receipts: DecisionReceiptV1[] = [];
      const clear = configureRuntimeActionDecisionSink((receipt) => {
        receipts.push(receipt);
        return true;
      });
      const controller = new AbortController();
      const run = withPluginRuntimePluginScope({ pluginId: "private-plugin-id" }, () =>
        runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
      );
      try {
        await Promise.race([started.promise, run]);
        expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce();
        if (end === "abort") {
          controller.abort(new Error("cancelled"));
          expect(mocks.close).toHaveBeenCalledOnce();
        }
        core.resolve({ payloads: [] });
        await expect(run).resolves.toEqual({ payloads: [] });
        expect(mocks.close).toHaveBeenCalledOnce();
        expect(receipts).toMatchObject([
          {
            decision: { outcome: "allowed", reasonCode: "plugin_runtime_owner_admitted" },
            enforcement: { coverageState: "enforced" },
          },
          ...(end === "completion"
            ? [
                {
                  decision: { outcome: "allowed", reasonCode: "plugin_runtime_completed" },
                  enforcement: { coverageState: "attribution-only" },
                },
              ]
            : []),
        ]);
        expect(JSON.stringify(receipts)).not.toContain("private-plugin-id");
      } finally {
        core.resolve({ payloads: [] });
        try {
          await run;
        } finally {
          clear();
        }
      }
    },
  );

  it.each(["before preparation", "during preparation"] as const)(
    "rejects cancellation %s without entering core execution",
    async (timing) => {
      const controller = new AbortController();
      const reason = timing === "before preparation" ? "already cancelled" : "raced cancellation";
      const cancel = () => controller.abort(new Error(reason));
      if (timing === "before preparation") {
        cancel();
      } else {
        mocks.prepareAgentRunAdmission.mockImplementationOnce(() => {
          cancel();
          return {
            operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
            admit: vi.fn(),
            close: mocks.close,
          };
        });
      }
      await expect(
        withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
          runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
        ),
      ).rejects.toThrow(reason);
      if (timing === "before preparation") {
        expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
      } else {
        expect(mocks.close).toHaveBeenCalledOnce();
      }
      expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
    },
  );

  it.each<{
    name: string;
    patch: Record<string, unknown>;
    inherited?: boolean;
    unscoped?: boolean;
    message: string;
  }>([
    {
      name: "missing plugin scope",
      patch: {},
      unscoped: true,
      message: "active plugin runtime scope",
    },
    {
      name: "forged memory audience",
      patch: { memoryAudience: { kind: "owner-private", agentId: "researcher" } },
      message: "memory audience must be host-minted",
    },
    ...[
      "admittedRunContext",
      "preparedRunAdmission",
      "onDeferredLifecycleOwner",
      "onDeferredLifecycleAbort",
      "onRetryWait",
      "compactionCountOwner",
      "onCompactionAccounting",
      "onContextAccountingEvent",
    ].map((field) => ({
      name: field,
      patch: { [field]: field === "compactionCountOwner" ? "caller" : {} },
      message: "cannot supply host run authority",
    })),
    ...["compactionCountOwner", "onCompactionAccounting", "onContextAccountingEvent"].map(
      (field) => ({
        name: `inherited ${field}`,
        inherited: true,
        patch: { [field]: field === "compactionCountOwner" ? "caller" : vi.fn() },
        message: "cannot supply host run authority",
      }),
    ),
  ])("rejects $name before admission", async ({ patch, inherited, unscoped, message }) => {
    const input = { ...params, ...(!inherited ? patch : {}) };
    if (inherited) {
      Object.setPrototypeOf(input, patch);
    }
    const invoke = () => runPluginEmbeddedAgent(input);
    await expect(
      unscoped ? invoke() : withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, invoke),
    ).rejects.toThrow(message);
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });
});

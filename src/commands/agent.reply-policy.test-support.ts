// Registered in the command suite to reuse its runtime and database fixture.
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createAgentHarnessCompletionScope,
  withAgentHarnessCompletionAdmission,
} from "../agents/agent-harness-completion-scope.js";
import { deliverAgentCommandResult } from "../agents/command/delivery.runtime.js";
import { prepareAgentCommandExecution } from "../agents/command/prepare.js";
import { readEmbeddedMessageDeliveryFact } from "../agents/embedded-agent-message-delivery.js";
import { withPreparedEmbeddedGatewayTools } from "../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import { resolveEmbeddedRunTerminal } from "../agents/embedded-agent-runner/run/terminal-resolution.js";
import {
  makeTerminalInput,
  type TerminalInput,
} from "../agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { sendSubagentAnnounceDirectly } from "../agents/subagents/announce/subagent-announce-direct-delivery.js";
import * as announceRuntime from "../agents/subagents/announce/subagent-announce.runtime.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { readToolResultDetails } from "../agents/tool-result-error.js";
import { createMessageTool } from "../agents/tools/message-tool-execution.js";
import { resolveSessionStableReplyMode } from "../auto-reply/reply/session-stable-reply-mode.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../gateway/agent-runtime-approval-authority.js";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
import { sendHandlers } from "../gateway/server-methods/send.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { getAgentAttemptExecutionMocks } from "./agent-command-state.test-mocks.js";
import { writeSessionStoreSeed } from "./agent-session.test-support.js";
import { agentCommand, agentCommandFromGatewayIngress } from "./agent.js";

export function registerAgentReplyPolicyTests({
  withTempHome,
  mockConfig,
  runtime,
}: {
  withTempHome: <T>(fn: (home: string) => Promise<T>) => Promise<T>;
  mockConfig: (
    home: string,
    storePath: string,
    agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  ) => OpenClawConfig;
  runtime: RuntimeEnv;
}) {
  it.each([
    { name: "already delivered result", admitted: true, text: SILENT_REPLY_TOKEN, silent: true },
    {
      name: "message-tool-only already delivered result",
      admitted: true,
      text: SILENT_REPLY_TOKEN,
      silent: true,
      toolOnly: true,
    },
    { name: "new information", admitted: true, text: "Additional findings.", silent: false },
    {
      name: "message-tool-only new information",
      admitted: true,
      text: "Additional findings.",
      silent: false,
      toolOnly: true,
    },
    {
      name: "message-tool-only requester replaced during message preparation",
      admitted: true,
      text: "Stale findings must not be sent.",
      silent: false,
      toolOnly: true,
      replaceRequester: true,
    },
    { name: "real user", admitted: false, source: "user", text: SILENT_REPLY_TOKEN },
    { name: "empty user answer", admitted: false, source: "user", text: "" },
    { name: "forged completion provenance", admitted: false, text: SILENT_REPLY_TOKEN },
    { name: "admitted task", admitted: true, source: "task", text: SILENT_REPLY_TOKEN },
    { name: "private completion", admitted: true, private: true, text: SILENT_REPLY_TOKEN },
    { name: "subagent lane", admitted: true, lane: "subagent", text: SILENT_REPLY_TOKEN },
    { name: "subagent session", admitted: true, child: true, text: SILENT_REPLY_TOKEN },
    { name: "internal surface", admitted: true, internal: true, text: SILENT_REPLY_TOKEN },
  ])(
    "resolves $name through command admission, terminal policy, and delivery",
    async (testCase) => {
      await withTempHome(async (home) => {
        const storePath = path.join(home, "sessions.json");
        const sessionKey =
          "child" in testCase
            ? "agent:main:subagent:requester"
            : "agent:main:discord:direct:requester";
        const sourceSessionKey = "codex-thread:synthetic-child";
        await writeSessionStoreSeed(storePath, {
          [sessionKey]: {
            sessionId: "requester-session",
            updatedAt: Date.now(),
            chatType: "direct",
            delivery: normalizeSessionDeliveryState({
              context: { channel: "discord", to: "user:requester" },
              origin: { provider: "discord", chatType: "direct", to: "user:requester" },
            }),
          },
        });
        const cfg = mockConfig(home, storePath);
        if ("toolOnly" in testCase) {
          cfg.messages = { visibleReplies: "message_tool" };
          const replyPolicy = await vi.importActual<
            typeof import("../auto-reply/reply/session-stable-reply-mode.js")
          >("../auto-reply/reply/session-stable-reply-mode.js");
          vi.mocked(resolveSessionStableReplyMode).mockImplementation(
            replyPolicy.resolveSessionStableReplyMode,
          );
        }
        let replacedDuringPreparation = false;
        const sendText = vi.fn(async (_params: { text: string }) => ({
          channel: "discord" as const,
          messageId: "sent",
        }));
        const plugin = createOutboundTestPlugin({
          id: "discord",
          outbound: { ...createDirectOutboundTestAdapter({ channel: "discord" }), sendText },
        });
        if ("toolOnly" in testCase) {
          plugin.actions = {
            describeMessageTool: () => ({ actions: ["send"] }),
            supportsAction: ({ action }) => action === "send",
            resolveExecutionMode: () => "gateway",
            handleAction: async ({ params }) => {
              const accepted = await sendText({ text: String(params.message) });
              const result = { message: { id: accepted.messageId } };
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                details: result,
              };
            },
          };
        }
        const registry = createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            plugin,
          },
        ]);
        setActivePluginRegistry(registry);
        if (!sendHandlers["message.action"]) {
          throw new Error("Expected the Gateway message action owner");
        }
        const gatewaySend = vi.fn(sendHandlers["message.action"]);
        const methods = createGatewayMethodRegistry([
          {
            name: "message.action",
            owner: { kind: "core", area: "message" },
            scope: "operator.write",
            handler: gatewaySend,
          },
        ]);
        const gatewayContext = {
          getRuntimeConfig: () => cfg,
          getGatewayMethodRegistry: () => methods,
          validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
          trackExecution: <T>(execute: () => Promise<T>) => execute(),
          dedupe: new Map(),
        } as GatewayRequestContext;
        const resolveGatewayContext = () => gatewayContext;
        const scheduler = createTestGatewayScheduler();
        const resourceHost = new LegacyPluginSdkResourceHost();
        resourceHost.bindScheduler(scheduler);
        bindLegacyPluginSdkResourceHost(resolveGatewayContext, resourceHost);
        await using _ = {
          async [Symbol.asyncDispose]() {
            await scheduler.stop();
            await resourceHost.close();
          },
        };
        getAgentAttemptExecutionMocks().useRealRunAgentAttempt = true;
        const delivery = await vi.importActual<typeof import("../agents/command/delivery.js")>(
          "../agents/command/delivery.js",
        );
        const inputs: TerminalInput[] = [];
        let output = "Initial answer.";
        let completionClaim: ReturnType<typeof loadSessionEntry>;
        const messageReceipts: ReturnType<typeof readEmbeddedMessageDeliveryFact>[] = [];
        let messageFailure: unknown;
        // Substitute inference only; retain command-built policy, terminal recovery,
        // and the real outbound adapter boundary without contacting a live channel.
        vi.mocked(runEmbeddedAgent).mockImplementation(async (runParams) => {
          try {
            if (runParams.runId === "announce:harness:completion") {
              completionClaim = loadSessionEntry({ sessionKey, storePath });
            }
            let messageReceipt: ReturnType<typeof readEmbeddedMessageDeliveryFact>;
            if ("toolOnly" in testCase && output !== SILENT_REPLY_TOKEN) {
              if (!runParams.preparedRunAdmission) {
                throw new Error("Expected command-owned run admission");
              }
              const admittedRunContext = await runParams.preparedRunAdmission.admit("embedded");
              const tool = withPluginRuntimeRegistryScope(registry, () =>
                createMessageTool({
                  config: cfg,
                  agentId: "main",
                  agentSessionKey: sessionKey,
                  runId: runParams.runId,
                  sessionId: runParams.sessionId,
                  currentChannelProvider: runParams.messageChannel,
                  currentMessagingTarget: runParams.currentMessagingTarget,
                  currentChannelId: runParams.currentChannelId,
                  sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
                  inputProvenance: runParams.inputProvenance,
                  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
                  resolveCommandSecretRefsViaGateway: async ({ config }) => {
                    if (
                      "replaceRequester" in testCase &&
                      runParams.runId === "announce:harness:completion"
                    ) {
                      const entry = loadSessionEntry({ sessionKey, storePath });
                      if (!entry) {
                        throw new Error("Expected the claimed requester before replacement");
                      }
                      await replaceSessionEntry(
                        { sessionKey, storePath },
                        {
                          ...entry,
                          sessionId: "replacement-requester",
                          lifecycleRevision: "replaced",
                        },
                      );
                      replacedDuringPreparation = true;
                    }
                    return {
                      resolvedConfig: config,
                      diagnostics: [],
                      targetStatesByPath: {},
                      hadUnresolvedTargets: false,
                    };
                  },
                }),
              );
              const result = await withPluginRuntimeRegistryScope(registry, () =>
                withPreparedEmbeddedGatewayTools(
                  {
                    ...runParams,
                    admittedRunContext,
                    agentId: "main",
                    sessionKey,
                    agentHarnessId: "builtin-openclaw",
                  },
                  () =>
                    tool.execute(`message:${runParams.runId}`, {
                      action: "send",
                      channel: "discord",
                      target: "user:requester",
                      message: output,
                    }),
                ),
              );
              messageReceipt = readEmbeddedMessageDeliveryFact(
                readToolResultDetails(result)?.messageDelivery,
              );
              messageReceipts.push(messageReceipt);
              expect(messageReceipt).toMatchObject({
                status: "settled",
                sourceReplyDelivered: true,
                partialDelivery: false,
                primaryPlatformMessageId: "sent",
              });
            }
            const resolve = async (text: string, prior?: TerminalInput) => {
              const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
              const input = makeTerminalInput({
                runParams,
                attempt: makeEmbeddedRunnerAttempt({
                  assistantTexts: [text],
                  lastAssistant: assistant,
                  currentAttemptAssistant: assistant,
                  currentAttemptReplayMetadata: {
                    hadPotentialSideEffects: messageReceipt?.status === "settled",
                    replaySafe: messageReceipt?.status !== "settled",
                  },
                  ...(messageReceipt
                    ? {
                        didSendViaMessagingTool: messageReceipt.status === "settled",
                        sourceReplyDelivered: messageReceipt.sourceReplyDelivered,
                        sourceReplyDeliveryState: messageReceipt.sourceReplyDelivered
                          ? "delivered"
                          : "missing",
                        messagingToolSentTexts: [output],
                      }
                    : {}),
                }),
                finalAssistantRawText: text,
                payloadsWithToolMedia: buildEmbeddedRunPayloads({
                  assistantTexts: [text],
                  lastAssistant: assistant,
                  currentAssistant: assistant,
                  sessionKey,
                  config: runParams.config,
                }),
                ...(prior
                  ? { retryState: prior.retryState, sessionPromptState: prior.sessionPromptState }
                  : {}),
              });
              inputs.push(input);
              return { input, terminal: await resolveEmbeddedRunTerminal(input) };
            };
            let resolved = await resolve(messageReceipt ? SILENT_REPLY_TOKEN : output);
            if (resolved.terminal.action === "retry") {
              resolved = await resolve("Recovered visible answer.", resolved.input);
            }
            if (resolved.terminal.action !== "complete") {
              throw new Error("Expected the synthetic model's visible answer to complete");
            }
            return resolved.terminal.result;
          } catch (error) {
            messageFailure = error;
            throw error;
          }
        });
        const run = async (opts: Parameters<typeof agentCommand>[0]) => {
          const deliveryMock = vi.mocked(deliverAgentCommandResult);
          const previousDelivery = deliveryMock.getMockImplementation();
          // The command fixture has an empty prepared registry; bind only its transport.
          deliveryMock.mockImplementation((...args) =>
            withPluginRuntimeRegistryScope(registry, () =>
              delivery.deliverAgentCommandResult(...args),
            ),
          );
          try {
            const commandOpts = {
              sessionKey,
              channel: "discord",
              to: "user:requester",
              deliver: true,
              ...opts,
            };
            return "toolOnly" in testCase
              ? await withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
                  agentCommandFromGatewayIngress(
                    {
                      ...commandOpts,
                      allowModelOverride: false,
                      senderIsOwner: true,
                      onAdmittedRunContext: (admitted) =>
                        bindGatewayContextResolver(admitted, resolveGatewayContext),
                    },
                    runtime,
                    undefined,
                    {},
                  ),
                )
              : await agentCommand(commandOpts, runtime);
          } finally {
            if (previousDelivery) {
              deliveryMock.mockImplementation(previousDelivery);
            } else {
              deliveryMock.mockReset();
            }
          }
        };
        await run({ message: "Summarize the findings", runId: "original-user-turn" });
        expect(sendText).toHaveBeenCalledOnce();
        sendText.mockClear();
        gatewaySend.mockClear();
        messageReceipts.length = 0;
        inputs.length = 0;
        output = testCase.text;
        const runId = testCase.admitted ? "announce:harness:completion" : "untrusted-user-turn";
        const opts: Parameters<typeof agentCommand>[0] = {
          message: "Background work finished",
          runId,
          ...("private" in testCase ? { privateCompletion: true } : {}),
          ...("lane" in testCase ? { lane: testCase.lane } : {}),
          ...("internal" in testCase
            ? { runContext: { messageChannel: "webchat" }, replyChannel: "discord" }
            : {}),
          ...("source" in testCase && testCase.source === "user"
            ? {}
            : {
                inputProvenance: {
                  kind: "inter_session",
                  sourceChannel: "internal",
                  sourceTool:
                    "source" in testCase && testCase.source === "task"
                      ? "agent_harness_task"
                      : "agent_harness_completion",
                  sourceSessionKey,
                },
              }),
        };
        if (testCase.admitted) {
          const entry = loadSessionEntry({ sessionKey, storePath });
          if (!entry) {
            throw new Error("Expected the actual requester session to exist");
          }
          const invoke = async () => {
            if (!("silent" in testCase)) {
              await run(opts);
              return;
            }
            const handle = {
              runId: "original-user-finalizing",
              queueMessage: vi.fn(async () => {}),
              isStreaming: () => true,
              isCompacting: () => false,
              abort: vi.fn(),
            };
            const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
            const dispatch = vi.spyOn(announceRuntime, "dispatchGatewayMethodInProcess");
            dispatch.mockImplementation(
              async <T>(
                _method: string,
                params: Record<string, unknown>,
                options?: Parameters<typeof announceRuntime.dispatchGatewayMethodInProcess>[2],
              ) => {
                clearActiveEmbeddedRun(entry.sessionId, handle, sessionKey);
                options?.onAccepted?.({ status: "accepted", runId });
                options?.onExecutionStarted?.();
                const result = await run({
                  ...params,
                  message: String(params.message),
                  runId: String(params.idempotencyKey),
                });
                return { status: "ok", result } as T;
              },
            );
            setActiveEmbeddedRun(entry.sessionId, handle, sessionKey);
            try {
              const result = await sendSubagentAnnounceDirectly({
                requesterSessionKey: sessionKey,
                targetRequesterSessionKey: sessionKey,
                requesterAgentId: "main",
                triggerMessage: "Background work finished",
                requesterIsSubagent: false,
                expectsCompletionMessage: true,
                directIdempotencyKey: runId,
                sourceSessionKey,
                sourceTool: "agent_harness_completion",
                directOrigin: { channel: "discord", to: "user:requester" },
              });
              expect(dispatch).toHaveBeenCalledOnce();
              expect(dispatch.mock.calls[0]?.[1].deliver).toBe(!("toolOnly" in testCase));
              expect(handle.queueMessage).not.toHaveBeenCalled();
              expect(log).toHaveBeenCalledWith(
                expect.stringContaining("reason=transcript_commit_wait_unsupported"),
              );
              expect(completionClaim?.restartRecoveryHarnessCompletion).toMatchObject({
                taskRunId: sourceSessionKey,
                sourceRunId: runId,
              });
              expect(completionClaim?.restartRecoveryDeliverySourceRunId).toBe(runId);
              expect(completionClaim?.restartRecoverySourceReplyDeliveryMode).toBe(
                "toolOnly" in testCase ? "message_tool_only" : "automatic",
              );
              if ("replaceRequester" in testCase) {
                expect(replacedDuringPreparation).toBe(true);
                expect(messageFailure).toMatchObject({
                  message: "agent tool caller authority is no longer active",
                });
                expect(result.delivered).toBe(false);
                expect(gatewaySend).not.toHaveBeenCalled();
                expect(sendText).not.toHaveBeenCalled();
                expect(messageReceipts).toEqual([]);
                expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(
                  "replacement-requester",
                );
                return;
              }
              expect(messageFailure).toBeUndefined();
              expect(inputs).toHaveLength(1);
              expect(inputs[0]?.retryState.emptyResponseAttempts ?? 0).toBe(0);
              expect(result).toMatchObject({ delivered: true, path: "direct" });
              const settled = loadSessionEntry({ sessionKey, storePath });
              expect(settled?.restartRecoveryHarnessCompletion).toBeUndefined();
              expect(settled?.restartRecoveryTerminalDeliveryEvidence).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    runId,
                    captured: true,
                    harnessCompletion: expect.objectContaining({
                      taskRunId: sourceSessionKey,
                      sourceRunId: runId,
                    }),
                  }),
                ]),
              );
            } finally {
              clearActiveEmbeddedRun(entry.sessionId, handle, sessionKey);
              dispatch.mockRestore();
              log.mockRestore();
            }
          };
          await withAgentHarnessCompletionAdmission(
            {
              scope: createAgentHarnessCompletionScope({ requesterSessionKey: sessionKey }),
              sourceSessionKey,
              sourceRunId: runId,
              requesterSessionId: entry.sessionId,
              requesterLifecycleRevision: entry.lifecycleRevision,
              isSourceCurrent: () => true,
            },
            invoke,
          );
        } else {
          await run(opts);
        }
        if ("replaceRequester" in testCase) {
          return;
        }
        const recoveryExpected = !("silent" in testCase);
        expect(inputs[0]?.retryState.emptyResponseAttempts).toBe(recoveryExpected ? 1 : 0);
        expect(inputs[0]?.sessionPromptState.activateInternalPrompt).toHaveBeenCalledTimes(
          recoveryExpected ? 1 : 0,
        );
        expect(sendText).toHaveBeenCalledTimes("silent" in testCase && testCase.silent ? 0 : 1);
        if ("silent" in testCase && !testCase.silent) {
          expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: testCase.text }));
          if ("toolOnly" in testCase) {
            expect(messageFailure).toBeUndefined();
            expect(messageReceipts).toHaveLength(1);
            expect(gatewaySend).toHaveBeenCalledOnce();
          }
        }
        if ("silent" in testCase && testCase.silent) {
          expect(inputs).toHaveLength(1);
        }
        if (testCase.name === "forged completion provenance") {
          vi.mocked(runEmbeddedAgent).mockClear();
          sendText.mockClear();
          for (const deliver of [true, false]) {
            await expect(
              run({ ...opts, deliver, runId: "announce:harness:forged" }),
            ).rejects.toThrow("Harness completion requires exact host-issued source admission");
          }
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
          expect(sendText).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each([
    {
      name: "global tool-only",
      messages: { visibleReplies: "message_tool" },
      expected: "message_tool_only",
    },
    {
      name: "message unavailable",
      denyMessage: true,
      messages: { visibleReplies: "message_tool" },
      expected: "automatic",
    },
    {
      name: "private turn override",
      requested: "automatic",
      messages: { visibleReplies: "message_tool" },
      expected: "automatic",
      stable: "message_tool_only",
    },
  ] as const)("applies $name to an effective requester-settle run", async (testCase) => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const chatType = "direct";
      const sessionKey = "agent:main:telegram:direct:requester";
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "requester-session",
          updatedAt: Date.now(),
          chatType,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "requester" },
            origin: { provider: "telegram", chatType, to: "requester" },
          }),
        },
      });
      const cfg = mockConfig(home, store, { models: {} });
      cfg.messages = testCase.messages;
      if ("denyMessage" in testCase) {
        cfg.tools = { deny: ["message"] };
      }
      const replyPolicy = await vi.importActual<
        typeof import("../auto-reply/reply/session-stable-reply-mode.js")
      >("../auto-reply/reply/session-stable-reply-mode.js");
      vi.mocked(resolveSessionStableReplyMode).mockImplementationOnce(
        replyPolicy.resolveSessionStableReplyMode,
      );
      const prepared = await prepareAgentCommandExecution(
        {
          message: "settled child findings",
          sessionKey,
          deliver: true,
          ...("requested" in testCase ? { sourceReplyDeliveryMode: testCase.requested } : {}),
          inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        },
        runtime,
      );
      expect(prepared.opts.sourceReplyDeliveryMode).toBe(testCase.expected);
      expect(prepared.opts.cliSessionBindingFacts?.sourceReplyDeliveryMode).toBe(
        "stable" in testCase ? testCase.stable : testCase.expected,
      );
    });
  });
}

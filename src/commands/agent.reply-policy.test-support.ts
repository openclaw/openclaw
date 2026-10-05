// Registered in the command suite to reuse its runtime and database fixture.
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createAgentHarnessCompletionScope,
  withAgentHarnessCompletionAdmission,
} from "../agents/agent-harness-completion-scope.js";
import { deliverAgentCommandResult } from "../agents/command/delivery.runtime.js";
import { prepareAgentCommandExecution } from "../agents/command/prepare.js";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import { resolveEmbeddedRunTerminal } from "../agents/embedded-agent-runner/run/terminal-resolution.js";
import {
  makeTerminalInput,
  type TerminalInput,
} from "../agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveSessionStableReplyMode } from "../auto-reply/reply/session-stable-reply-mode.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { getAgentAttemptExecutionMocks } from "./agent-command-state.test-mocks.js";
import { writeSessionStoreSeed } from "./agent-session.test-support.js";
import { agentCommand } from "./agent.js";

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
    { name: "new information", admitted: true, text: "Additional findings.", silent: false },
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
        mockConfig(home, storePath);
        const sendText = vi.fn(async () => ({ channel: "discord" as const, messageId: "sent" }));
        const registry = createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "discord",
              outbound: { ...createDirectOutboundTestAdapter({ channel: "discord" }), sendText },
            }),
          },
        ]);
        setActivePluginRegistry(registry);
        getAgentAttemptExecutionMocks().useRealRunAgentAttempt = true;
        const delivery = await vi.importActual<typeof import("../agents/command/delivery.js")>(
          "../agents/command/delivery.js",
        );
        const inputs: TerminalInput[] = [];
        let output = "Initial answer.";
        // Substitute inference only; retain command-built policy, terminal recovery,
        // and the real outbound adapter boundary without contacting a live channel.
        vi.mocked(runEmbeddedAgent).mockImplementation(async (runParams) => {
          const resolve = async (text: string, prior?: TerminalInput) => {
            const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
            const input = makeTerminalInput({
              runParams,
              attempt: makeEmbeddedRunnerAttempt({
                assistantTexts: [text],
                lastAssistant: assistant,
                currentAttemptAssistant: assistant,
                currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
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
          let resolved = await resolve(output);
          if (resolved.terminal.action === "retry") {
            resolved = await resolve("Recovered visible answer.", resolved.input);
          }
          if (resolved.terminal.action !== "complete") {
            throw new Error("Expected the synthetic model's visible answer to complete");
          }
          return resolved.terminal.result;
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
            return await agentCommand(
              { sessionKey, channel: "discord", to: "user:requester", deliver: true, ...opts },
              runtime,
            );
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
          await withAgentHarnessCompletionAdmission(
            {
              scope: createAgentHarnessCompletionScope({ requesterSessionKey: sessionKey }),
              sourceSessionKey,
              sourceRunId: runId,
              requesterSessionId: entry.sessionId,
              requesterLifecycleRevision: entry.lifecycleRevision,
              isSourceCurrent: () => true,
            },
            () => run(opts),
          );
        } else {
          await run(opts);
        }
        const recoveryExpected = !("silent" in testCase);
        expect(inputs[0]?.retryState.emptyResponseAttempts).toBe(recoveryExpected ? 1 : 0);
        expect(inputs[0]?.sessionPromptState.activateInternalPrompt).toHaveBeenCalledTimes(
          recoveryExpected ? 1 : 0,
        );
        expect(sendText).toHaveBeenCalledTimes("silent" in testCase && testCase.silent ? 0 : 1);
        if (testCase.name === "new information") {
          expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: testCase.text }));
        }
        if ("silent" in testCase && testCase.silent) {
          expect(inputs).toHaveLength(1);
        }
        if (testCase.name === "forged completion provenance") {
          vi.mocked(runEmbeddedAgent).mockClear();
          sendText.mockClear();
          await expect(run({ ...opts, runId: "announce:harness:forged" })).rejects.toThrow(
            "Harness completion requires exact host-issued source admission",
          );
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
          expect(sendText).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("keeps synthetic direct-DM delivery mode out of existing CLI binding facts", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:discord:direct:requester";
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "requester-session",
          updatedAt: Date.now(),
          chatType: "direct",
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "native-claude-session",
              messageToolPolicyHash: "automatic-policy-hash",
            },
          },
          delivery: normalizeSessionDeliveryState({
            context: { channel: "discord", to: "user:requester" },
            origin: { provider: "discord", chatType: "direct", to: "user:requester" },
          }),
        },
      });
      const cfg = mockConfig(home, store, {
        models: {
          "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
        },
      });
      cfg.messages = { visibleReplies: "automatic" };

      const prepared = await prepareAgentCommandExecution(
        {
          message: "child completed",
          sessionKey,
          sourceReplyDeliveryMode: "message_tool_only",
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:subagent:child",
            sourceTool: "subagent_announce",
          },
        },
        runtime,
      );

      expect(prepared.opts.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(prepared.opts.cliSessionBindingFacts).toEqual({
        sourceReplyDeliveryMode: "automatic",
      });
      expect(prepared.sessionEntry?.cliSessionBindings?.["claude-cli"]).toMatchObject({
        sessionId: "native-claude-session",
        messageToolPolicyHash: "automatic-policy-hash",
      });
    });
  });

  it.each([
    {
      name: "global tool-only",
      messages: { visibleReplies: "message_tool" },
      expected: "message_tool_only",
    },
    { name: "global automatic", messages: { visibleReplies: "automatic" }, expected: "automatic" },
    {
      name: "group automatic override",
      group: true,
      messages: { visibleReplies: "message_tool", groupChat: { visibleReplies: "automatic" } },
      expected: "automatic",
    },
    {
      name: "group tool-only override",
      group: true,
      messages: { visibleReplies: "automatic", groupChat: { visibleReplies: "message_tool" } },
      expected: "message_tool_only",
    },
    {
      name: "message unavailable",
      denyMessage: true,
      messages: { visibleReplies: "message_tool" },
      expected: "automatic",
    },
    { name: "default group", group: true, messages: {}, expected: "automatic" },
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
      const chatType = "group" in testCase ? "group" : "direct";
      const sessionKey = "agent:main:telegram:" + chatType + ":requester";
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

import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { parseTelegramTargetForTest } from "../../test/helpers/infra/telegram-targets.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { waitForExecScope } from "../agents/bash-process-registry.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import { nodeCommand } from "../agents/bash-tools.lifecycle.test-support.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { buildPayloads } from "../agents/embedded-agent-runner/run/payloads.test-helpers.js";
import { resolveEmbeddedRunTerminal } from "../agents/embedded-agent-runner/run/terminal-resolution.js";
import {
  expectComplete,
  makeTerminalInput,
  textAssistant,
} from "../agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import * as runtimePlugins from "../agents/runtime-plugins.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as routedReplies from "../auto-reply/reply/route-reply.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { resolveSystemEventQueueKey } from "./system-event-ownership.js";
import { peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

// mock-isolation: Replace model inference while retaining ordinary admission, tools, and delivery custody.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

type CompletionRoutingCase = {
  name: string;
  reply?: "quiet" | "failed" | "tool-warning" | "status" | "truncated" | "chain";
  global?: true;
  redirected?: true;
  changeRoute?: "topic" | "account";
  actionableFailure?: true;
  groupMessageToolOnly?: true;
};
const completionRoutingCases: CompletionRoutingCase[] = [
  { name: "group session" },
  { name: "quiet outcome", reply: "quiet" },
  { name: "report redirected to a file", redirected: true },
  { name: "global session", global: true },
  { name: "group-only message-tool delivery policy", groupMessageToolOnly: true },
  { name: "conversation moved to another topic", changeRoute: "topic" },
  { name: "command started on another account", changeRoute: "account" },
  { name: "failed turn", reply: "failed" },
  {
    name: "failed turn with actionable provider guidance",
    reply: "failed",
    actionableFailure: true,
  },
  { name: "failed tool, no final text", reply: "tool-warning" },
  { name: "answer with a trailing status notice", reply: "status" },
  { name: "answer cut off by the output limit", reply: "truncated" },
  { name: "command started by the conversation's own completion turn", reply: "chain" },
];

it.for(completionRoutingCases)(
  "routes background exec completion through its originating session: $name",
  async (testCase, { signal, onTestFinished }) => {
    const fixtureWork = withOpenClawTestState(
      { label: "ordinary-exec-route", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const topic = "telegram:-100155462274:topic:42";
        const accountId = testCase.changeRoute === "account" ? "work" : "default";
        const scope = {
          agentId: "main",
          sessionKey: testCase.global
            ? "global"
            : "agent:main:telegram:group:-100155462274:topic:42",
        };
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
          messages: {
            visibleReplies: "automatic",
            ...(testCase.groupMessageToolOnly
              ? { groupChat: { visibleReplies: "message_tool" as const } }
              : {}),
          },
          channels: {
            telegram: {
              botToken: "test-token",
              allowFrom: ["*"],
            },
          },
          session: { scope: testCase.global ? "global" : "per-sender" },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        await replaceSessionEntry(scope, {
          sessionId: "topic-conversation",
          lifecycleRevision: "original",
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
          permissionMode: "full",
          chatType: "group",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: topic, accountId, threadId: 42 },
          }),
        });
        const send = vi.fn(async (to: string, _text: string) => ({
          messageId: "completion",
          chatId: to,
        }));
        const plugin = createOutboundTestPlugin({
          id: "telegram",
          messaging: {
            inferTargetChatType: ({ to }) => {
              const target = parseTelegramTargetForTest(to);
              return target.chatType === "unknown" ? undefined : target.chatType;
            },
          },
          outbound: {
            deliveryMode: "direct",
            sendText: async ({ to, text }) => ({ channel: "telegram", ...(await send(to, text)) }),
          },
        });
        const previousRegistry = captureActivePluginRegistrySnapshot();
        const registry = createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]);
        setActivePluginRegistry(registry);
        const runtimeRegistry = vi
          .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
          .mockReturnValue(registry);
        const sendRaw = vi.spyOn(routedReplies, "routeReply");
        const sendPrepared = vi.spyOn(routedReplies, "routePreparedReply");
        const receipts: sessionEvents.SessionEventReceipt[] = [];
        const enqueue = sessionEvents.enqueueSessionEventForHost;
        const observe = vi
          .spyOn(sessionEvents, "enqueueSessionEventForHost")
          .mockImplementation((text, options) => {
            const receipt = enqueue(text, options);
            receipts.push(receipt);
            return receipt;
          });
        const modelEntered = createDeferred();
        const routeReady = createDeferred();
        const answer = "The job printed RESULT-7F3A.";
        const actionableFailureText = "⚠️ Provider authentication expired. Sign in again.";
        const toolError = { toolName: "exec", error: "Command exited with code 1" };
        const makeExec = (trigger: "user" | "event") =>
          createExecTool({
            config,
            ...scope,
            scopeKey: scope.sessionKey,
            host: "gateway",
            security: "full",
            ask: "off",
            allowBackground: true,
            notifyOnExit: true,
            trigger,
            messageProvider: "telegram",
            currentChannelId: topic,
            currentThreadTs: "42",
            accountId,
          });
        let calls = 0;
        model.mockReset().mockImplementation(async (params: RunEmbeddedAgentParams) => {
          const admission = expectDefined(params.preparedRunAdmission, "ordinary turn admission");
          const admitted = await admission.admit("gateway", params.runId);
          await params.userTurnTranscriptRecorder?.persistApproved();
          params.onExecutionPhase?.({ phase: "model_call_started" });
          await params.onExecutionStarted?.();
          await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
          expect(params.trigger).toBe("event");
          expect(params.prompt).toContain("[OpenClaw exec completion]");
          expect(params.prompt).toContain("requested results not yet delivered");
          expect(params.prompt).toContain("duplicate or superseded results");
          expect(params.prompt).toContain("reply NO_REPLY only");
          expect(params.sessionKey).toBe(scope.sessionKey);
          expect(params.chatType).toBe("group");
          expect(params.bootstrapContextMode).toBeUndefined();
          calls += 1;
          modelEntered.resolve();
          await withinTest(routeReady.promise, signal);
          if (testCase.reply === "chain" && calls === 1) {
            const identity = expectDefined(
              createAdmittedGatewayToolCallerIdentity({ admittedRunContext: admitted, ...scope }),
              "completion caller",
            );
            await withGatewayToolCallerIdentity(identity, () =>
              makeExec("event").execute("second-command", {
                command: nodeCommand('process.stdout.write("RESULT-2B4C")'),
                background: true,
              }),
            );
            return {
              payloads: [{ text: "First printed RESULT-7F3A; started the next one." }],
              meta: { durationMs: 1 },
            };
          }
          if (testCase.reply === "chain") {
            expect(params.prompt).toContain("RESULT-2B4C");
            return { payloads: [{ text: "Second printed RESULT-2B4C." }], meta: { durationMs: 1 } };
          }
          expect(params.prompt.includes("RESULT-7F3A")).toBe(
            !testCase.redirected && testCase.reply !== "quiet",
          );
          if (testCase.redirected || testCase.reply === "quiet") {
            expect(params.prompt).toContain("Exec completed");
          }
          if (testCase.redirected) {
            expect(await fs.readFile(state.path("report.txt"), "utf8")).toBe("RESULT-7F3A");
          }
          if (testCase.reply === "failed") {
            if (!testCase.actionableFailure) {
              throw new Error("opaque-private-runner-detail");
            }
            return {
              payloads: [{ text: actionableFailureText, isError: true }],
              meta: {
                durationMs: 1,
                error: { kind: "retry_limit", message: "Synthetic terminal model failure" },
              },
            };
          }
          if (testCase.reply === "tool-warning") {
            return {
              payloads: buildPayloads({ lastToolError: toolError }),
              meta: { durationMs: 1 },
            };
          }
          if (testCase.reply === "truncated") {
            const provider = expectDefined(params.provider, "admitted provider");
            const modelId = expectDefined(params.model, "admitted model");
            const assistant = textAssistant(answer, {
              provider,
              model: modelId,
              stopReason: "length",
            });
            const resolved = await resolveEmbeddedRunTerminal(
              makeTerminalInput({
                runParams: {
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  runId: params.runId,
                },
                provider,
                modelId,
                modelTransportId: modelId,
                activeErrorContext: { provider, model: modelId },
                agentMeta: { sessionId: params.sessionId, provider, model: modelId },
                reportedModelRef: { provider, model: modelId },
                assistant,
                attemptOverrides: {
                  assistantTexts: [answer],
                  currentAttemptReplayMetadata: {
                    hadPotentialSideEffects: false,
                    replaySafe: true,
                  },
                },
                payloadsWithToolMedia: [{ text: answer }],
              }),
            );
            expectComplete(resolved);
            return resolved.result;
          }
          return {
            payloads:
              testCase.reply === "status"
                ? [
                    { text: answer },
                    { text: "🧩 Active Memory: status=policy-disabled", isStatusNotice: true },
                  ]
                : testCase.reply === "quiet"
                  ? []
                  : [{ text: answer }],
            meta: {
              durationMs: 1,
              terminalReply:
                testCase.reply === "quiet"
                  ? { disposition: "silent" }
                  : { disposition: "visible", text: answer },
            },
          };
        });
        try {
          const command = nodeCommand(
            testCase.redirected
              ? `require("node:fs").writeFileSync(${JSON.stringify(state.path("report.txt"))}, "RESULT-7F3A")`
              : testCase.reply === "quiet"
                ? "void 0"
                : 'process.stdout.write("RESULT-7F3A")',
          );
          await makeExec("user").execute("first-command", { command, background: true });
          await waitForExecScope(scope.sessionKey);
          const first = expectDefined(receipts[0], "first ordinary completion");
          if (testCase.changeRoute) {
            await awaitGateBeforeSettlement(
              modelEntered.promise,
              first.settled,
              "Completion settled before entering the model",
            );
            await replaceSessionEntry(scope, {
              ...expectDefined(loadSessionEntry(scope), "original session"),
              delivery: normalizeSessionDeliveryState({
                context: {
                  channel: "telegram",
                  to: testCase.changeRoute === "topic" ? "telegram:-100155462274:topic:43" : topic,
                  accountId: "default",
                  threadId: testCase.changeRoute === "topic" ? 43 : 42,
                },
              }),
            });
          }
          routeReady.resolve();
          await expect(first.accepted).resolves.toEqual({ ok: true });
          const outcome = await withinTest(first.settled, signal);
          expect(outcome, JSON.stringify(outcome)).toMatchObject({
            status: testCase.reply === "failed" ? "failed" : "completed",
            executionStarted: true,
          });
          if (testCase.reply === "chain") {
            await waitForExecScope(scope.sessionKey);
            const second = expectDefined(receipts[1], "chained ordinary completion");
            await expect(second.accepted).resolves.toEqual({ ok: true });
            await expect(second.settled).resolves.toMatchObject({
              status: "completed",
              delivered: true,
            });
          }
          expect(model).toHaveBeenCalledTimes(testCase.reply === "chain" ? 2 : 1);
          const sent = send.mock.calls.map(([, text]) => text);
          if (testCase.reply === "quiet" || testCase.groupMessageToolOnly) {
            expect(sent).toEqual([]);
            if (testCase.groupMessageToolOnly) {
              expect(outcome.delivered).toBe(false);
            }
          } else if (testCase.reply === "failed") {
            expect(send, JSON.stringify({ sent, outcome })).toHaveBeenCalledTimes(
              testCase.actionableFailure ? 1 : 0,
            );
            if (testCase.actionableFailure) {
              expect(sendPrepared.mock.calls[0]?.[0].plan.payload).toMatchObject({
                isError: true,
                text: expect.stringContaining("Sign in again"),
              });
              expect(sent[0]).toContain("openclaw configure");
              expect(sent[0]).not.toContain(actionableFailureText);
              expect(sent[0]).not.toContain("Synthetic terminal model failure");
              expect(outcome.delivered).toBe(true);
            }
          } else if (testCase.reply === "tool-warning") {
            expect(sent).toEqual(["⚠️ Exec failed (exit 1)"]);
          } else if (testCase.reply === "chain") {
            expect(sent).toEqual([
              "First printed RESULT-7F3A; started the next one.",
              "Second printed RESULT-2B4C.",
            ]);
          } else {
            expect(sent.filter((text) => text?.includes("RESULT-7F3A"))).toEqual([answer]);
            if (testCase.reply === "status") {
              expect(sent).toContain("🧩 Active Memory: status=policy-disabled");
            }
            if (testCase.reply === "truncated") {
              expect(sent).toHaveLength(2);
            }
          }
          for (const [request] of [...sendRaw.mock.calls, ...sendPrepared.mock.calls]) {
            expect(request).toMatchObject({
              channel: "telegram",
              to: topic,
              accountId,
              threadId: "42",
              sessionKey: scope.sessionKey,
            });
          }
          expect(peekSystemEvents(resolveSystemEventQueueKey(scope.sessionKey, "main"))).toEqual(
            [],
          );
        } finally {
          routeReady.resolve();
          await waitForExecScope(scope.sessionKey);
          for (const receipt of receipts) {
            receipt.cancel();
          }
          await Promise.allSettled(receipts.map((receipt) => receipt.settled));
          observe.mockRestore();
          sendRaw.mockRestore();
          sendPrepared.mockRestore();
          runtimeRegistry.mockRestore();
          restoreActivePluginRegistrySnapshot(previousRegistry);
          resetProcessRegistryForTests();
          resetSystemEventsForTest();
        }
      },
    );
    onTestFinished(async () => {
      await Promise.allSettled([fixtureWork]);
    });
    await fixtureWork;
  },
);

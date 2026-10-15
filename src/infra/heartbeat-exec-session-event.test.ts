import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { waitForExecScope } from "../agents/bash-process-registry.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { buildPayloads } from "../agents/embedded-agent-runner/run/payloads.test-helpers.js";
import { resolveEmbeddedRunTerminal } from "../agents/embedded-agent-runner/run/terminal-resolution.js";
import { makeTerminalInput } from "../agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import * as runtimePlugins from "../agents/runtime-plugins.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as routedReplies from "../auto-reply/reply/route-reply.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeCronJobScratch } from "../cron/scratch-store.js";
import { CronService } from "../cron/service.js";
import { runCronSessionTurn } from "../cron/session-run.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
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

function nodeCommand(source: string): string {
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${quote(process.execPath)} -e ${quote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

function createAutomationFixture(config: OpenClawConfig, storePath: string, sessionKey: string) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: false,
    defaultAgentId: "main",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: async () => {
      throw new Error("Expected ordinary shared-session execution");
    },
    runSessionEvent: (request) =>
      runCronSessionTurn({ ...request, cfg: config, agentId: "main", sessionKey }),
  });
}

it.for(["none", "alerts-disabled", "visible"] as const)(
  "retains ordinary automation delivery policy through a real background exec: %s",
  async (policy, { signal, onTestFinished }) => {
    const fixtureWork = withOpenClawTestState(
      { label: "automation-exec-delivery", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const visible = policy === "visible";
        const destination = "-1001234567890";
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
          messages: { visibleReplies: "automatic" },
          channels: {
            telegram: { botToken: "test-token", allowFrom: ["*"] },
          },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        const scope = { agentId: "main", sessionKey: "agent:main:main" };
        await replaceSessionEntry(scope, {
          sessionId: "periodic-exec-session",
          lifecycleRevision: "original",
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
          permissionMode: "full",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: destination },
          }),
        });
        const storePath = state.statePath("cron", "jobs.json");
        const cron = createAutomationFixture(config, storePath, scope.sessionKey);
        const job = await cron.add({
          name: `Migrated periodic ${policy}`,
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 300_000 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message: "Run the background status check",
            toolsAllow: ["exec"],
          },
          delivery: visible
            ? { mode: "announce", channel: "telegram", to: destination }
            : { mode: "none" },
        });
        await writeCronJobScratch({
          storePath,
          jobId: job.id,
          content: "- Run the background status check\n",
        });
        const previousRegistry = captureActivePluginRegistrySnapshot();
        const registry = createTestRegistry([
          { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
        ]);
        setActivePluginRegistry(registry);
        const runtimeRegistry = vi
          .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
          .mockReturnValue(registry);
        const sendCompletion = vi
          .spyOn(routedReplies, "routeReply")
          .mockResolvedValue({ ok: true, delivered: true, messageId: "completion-send" });
        const completionCreated =
          createDeferred<ReturnType<typeof sessionEvents.enqueueSessionEventForHost>>();
        const enqueue = sessionEvents.enqueueSessionEventForHost;
        const observeCompletion = vi
          .spyOn(sessionEvents, "enqueueSessionEventForHost")
          .mockImplementation((text, options) => {
            const receipt = enqueue(text, options);
            if (options.source === "exec") {
              completionCreated.resolve(receipt);
            }
            return receipt;
          });
        model.mockReset().mockImplementation(async (params: RunEmbeddedAgentParams) => {
          const admission = expectDefined(params.preparedRunAdmission, "real turn admission");
          const admittedRunContext = await admission.admit("gateway", params.runId);
          params.onExecutionPhase?.({ phase: "model_call_started" });
          await params.onExecutionStarted?.();
          await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
          if (params.trigger === "cron") {
            expect(params.prompt).toContain("Run the background status check");
            const exec = createExecTool({
              config: params.config,
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              runSessionKey: params.sessionKey,
              sessionId: params.sessionId,
              runId: params.runId,
              operationalRunInstance: admittedRunContext.operationalRunInstance,
              scopeKey: scope.sessionKey,
              host: "gateway",
              security: "full",
              ask: "off",
              allowBackground: true,
              notifyOnExit: true,
              trigger: params.trigger,
            });
            const identity = expectDefined(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext,
                agentId: params.agentId,
                sessionKey: params.sessionKey,
              }),
              "admitted exec caller",
            );
            await withGatewayToolCallerIdentity(identity, async () => {
              const result = await exec.execute("periodic-background-check", {
                command: nodeCommand('process.stdout.write("PERIODIC_EXEC_COMPLETED")'),
                background: true,
              });
              expect(result.details.status).toBe("running");
              await waitForExecScope(scope.sessionKey);
            });
            return { payloads: [{ text: "Periodic work completed" }], meta: { durationMs: 1 } };
          }
          expect(params.trigger).toBe("event");
          expect(params.prompt).toContain("PERIODIC_EXEC_COMPLETED");
          return { payloads: [{ text: "Background result is ready" }], meta: { durationMs: 1 } };
        });
        let completion: ReturnType<typeof sessionEvents.enqueueSessionEventForHost> | undefined;
        try {
          await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
          const periodic = cron.getJob(job.id)?.state;
          expect(periodic, periodic?.lastError).toMatchObject({ lastRunStatus: "ok" });
          completion = await withinTest(completionCreated.promise, signal);
          await expect(completion.accepted).resolves.toEqual({ ok: true });
          const outcome = await completion.settled;
          expect(outcome, JSON.stringify(outcome)).toMatchObject({
            status: "completed",
            executionStarted: true,
            delivered: visible,
          });
          expect(model).toHaveBeenCalledTimes(2);
          expect(sendCompletion.mock.calls.map(([request]) => request.payload.text)).toEqual(
            visible ? ["Periodic work completed", "Background result is ready"] : [],
          );
          if (visible) {
            expect(sendCompletion).toHaveBeenCalledWith(
              expect.objectContaining({ channel: "telegram", to: destination }),
            );
          }
        } finally {
          cron.stop();
          await cron.waitForIdle();
          await waitForExecScope(scope.sessionKey);
          await Promise.allSettled([completion?.settled]);
          observeCompletion.mockRestore();
          sendCompletion.mockRestore();
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

type CompletionRoutingCase = {
  name: string;
  isolatedSession?: boolean;
  reply?: "quiet" | "failed" | "tool-warning" | "status" | "truncated" | "chain";
  target?: "none" | "last" | "owner";
  alerts?: false;
  global?: true;
  redirected?: true;
  changeRoute?: "topic" | "account";
  actionableFailure?: true;
  groupMessageToolOnly?: true;
};
const completionRoutingCases: CompletionRoutingCase[] = [
  { name: "isolated automation", isolatedSession: true },
  { name: "shared-session automation", isolatedSession: false },
  { name: "quiet outcome", reply: "quiet" },
  { name: "report redirected to a file", redirected: true },
  { name: "global session", global: true },
  { name: "migrated alerts-disabled delivery", alerts: false },
  { name: "group-only message-tool delivery policy", groupMessageToolOnly: true },
  { name: "conversation moved to another topic", changeRoute: "topic" },
  { name: "command started on another account", changeRoute: "account" },
  { name: "failed turn", reply: "failed" },
  {
    name: "failed turn, migrated alerts-disabled delivery",
    reply: "failed",
    target: "last",
    alerts: false,
  },
  { name: "failed turn, owner automation without an owner", reply: "failed", target: "owner" },
  { name: "failed turn, announcing automation", reply: "failed", target: "last" },
  {
    name: "failed turn with actionable provider guidance",
    reply: "failed",
    actionableFailure: true,
  },
  { name: "failed tool, no final text", reply: "tool-warning" },
  { name: "failed tool, announcing automation", reply: "tool-warning", target: "last" },
  { name: "answer with a trailing status notice", reply: "status" },
  { name: "answer cut off by the output limit", reply: "truncated" },
  { name: "command started by the conversation's own completion turn", reply: "chain" },
];

it.for(completionRoutingCases)(
  "routes ordinary background completion independently of periodic settings: $name",
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
        const cron = createAutomationFixture(
          config,
          state.statePath("cron", "jobs.json"),
          scope.sessionKey,
        );
        await cron.add({
          name: "Unrelated periodic automation",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 300_000 },
          activeHours: { start: "00:00", end: "00:00", timezone: "UTC" },
          sessionTarget: testCase.isolatedSession === false ? "main" : "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Periodic check", lightContext: true },
          delivery:
            testCase.alerts === false || !testCase.target || testCase.target === "none"
              ? { mode: "none" }
              : testCase.target === "owner"
                ? { mode: "announce", target: "owner" }
                : { mode: "announce", channel: "last" },
        });
        const previousRegistry = captureActivePluginRegistrySnapshot();
        const registry = createTestRegistry([
          { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
        ]);
        setActivePluginRegistry(registry);
        const runtimeRegistry = vi
          .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
          .mockReturnValue(registry);
        const send = vi
          .spyOn(routedReplies, "routeReply")
          .mockResolvedValue({ ok: true, delivered: true, messageId: "completion" });
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
          params.onExecutionPhase?.({ phase: "model_call_started" });
          await params.onExecutionStarted?.();
          await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
          expect(params.trigger).toBe("event");
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
            const assistant = buildEmbeddedRunnerAssistant({
              provider,
              model: modelId,
              stopReason: "length",
              content: [{ type: "text", text: answer }],
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
                attempt: makeEmbeddedRunnerAttempt({
                  assistantTexts: [answer],
                  lastAssistant: assistant,
                  currentAttemptAssistant: assistant,
                  currentAttemptReplayMetadata: {
                    hadPotentialSideEffects: false,
                    replaySafe: true,
                  },
                }),
                attemptAssistant: assistant,
                payloadsWithToolMedia: [{ text: answer }],
              }),
            );
            expect(resolved.action).toBe("complete");
            if (resolved.action !== "complete") {
              throw new Error("Truncated answer did not settle");
            }
            return resolved.result;
          }
          return {
            payloads:
              testCase.reply === "status"
                ? [
                    { text: answer },
                    { text: "🧩 Active Memory: status=policy-disabled", isStatusNotice: true },
                  ]
                : [{ text: testCase.reply === "quiet" ? "NO_REPLY" : answer }],
            meta: { durationMs: 1 },
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
          const sent = send.mock.calls.map(([request]) => request.payload.text);
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
              expect(send.mock.calls[0]?.[0].payload).toMatchObject({
                isError: true,
                text: expect.stringContaining("Sign in again"),
              });
              expect(sent[0]).toContain("openclaw configure");
              expect(sent[0]).not.toContain(actionableFailureText);
              expect(sent[0]).not.toContain("Synthetic terminal model failure");
              expect(outcome.delivered).toBe(true);
            }
          } else if (testCase.reply === "tool-warning") {
            expect(sent).toEqual([buildPayloads({ lastToolError: toolError })[0]?.text]);
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
          for (const [request] of send.mock.calls) {
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
          cron.stop();
          await cron.waitForIdle();
          routeReady.resolve();
          await waitForExecScope(scope.sessionKey);
          for (const receipt of receipts) {
            receipt.cancel();
          }
          await Promise.allSettled(receipts.map((receipt) => receipt.settled));
          observe.mockRestore();
          send.mockRestore();
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

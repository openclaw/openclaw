import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  createCronRegressionState,
  noopLogger,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  admitModelTurn,
  completionConfig,
} from "../../agents/bash-tools.lifecycle.test-support.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { WorkspaceAccessUnavailableError } from "../../agents/workspace-access.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-writable.js";
import { listSessionPendingInputs } from "../../config/sessions/session-pending-input-history.js";
import { resolveAdmittedCronCompletionStatus } from "../../cron/completion-status.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { memberSourceCase } from "../../cron/isolated-agent/run.invalid-source.test-support.js";
import { resolveCronRunErrorReason } from "../../cron/run-error-reason.js";
import {
  TEST_SCHEDULED_OCCURRENCE,
  TEST_SCHEDULED_TURN,
} from "../../cron/scheduled-occurrence.test-support.js";
import { CronService } from "../../cron/service.js";
import { writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { resolveCronOperatorExecutionRevision } from "../../cron/service/jobs-tool-policy.js";
import type { DeferredCronNotifications } from "../../cron/service/state.js";
import { applyJobResult } from "../../cron/service/timer-outcomes.js";
import { runCronSessionTurn } from "../../cron/session-run.js";
import type { CronStoredJob } from "../../cron/types.js";
import { createChatAbortSignalReason } from "../../gateway/chat-abort.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
} from "../../gateway/openclaw-id/tunnel-principal.js";
import { createScheduledGatewayRunner } from "../../gateway/scheduled-run-gateway-context.js";
import { runGatewayCronSessionEvent } from "../../gateway/server-cron-event-dispatch.js";
import { createGatewayCronTargetResolver } from "../../gateway/server-cron-targets.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import {
  peekDeliverableSystemEventEntries,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { linkOpenClawIdUserProfile } from "../../state/user-profile-openclaw-id.worker.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import * as agentExecution from "./agent-runner-execution.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import { configureEventState, startEmbeddedTurn } from "./session-event.test-support.js";
import * as sessionUpdates from "./session-updates.js";

// mock-isolation: Only model decisions are synthetic; tool, controller and storage owners stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
const summary = "Report ready.";
const failure = "Synthetic automation failed.";
const request = "Check the synthetic report.";
await Promise.all([
  import("../dispatch.js"),
  import("./get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

it("records operation-only Stop for a staged event before execution", async ({ signal }) => {
  await withOpenClawTestState(
    { label: "session-event-operation-stop", env: { OPENCLAW_TEST_FAST: "0" } },
    async (state) => {
      const config = completionConfig(state.workspaceDir);
      setRuntimeConfigSnapshot(config);
      await state.writeConfig(config);
      openOpenClawStateDatabase();
      const target = { agentId: "main", sessionKey: "agent:main:event-operation-stop" };
      await replaceSessionEntry(target, {
        sessionId: "event-operation-stop",
        permissionMode: "full",
        updatedAt: 1,
      });
      using execution = vi
        .spyOn(agentExecution, "executeAgentTurn")
        .mockImplementationOnce(async (params) => {
          expect(
            params.followupRun.userTurnTranscriptRecorder?.getPendingInputMessage?.(),
          ).toBeDefined();
          expect(expectDefined(params.replyOperation, "event operation").abortByUser()).toBe(true);
          throw new Error("execution refused after user Stop");
        });
      try {
        const expectedTarget = await captureSessionEventTargetForHost(
          target.agentId,
          target.sessionKey,
        );
        const receipt = enqueueSessionEventForHost("Stop this queued event", {
          ...target,
          source: "restart",
          expectedTarget,
          abortSignal: signal,
          deliver: false,
        });
        await withinTest(receipt.settled, signal);
        expect(execution).toHaveBeenCalledOnce();
        expect(signal.aborted).toBe(false);
        expect(
          await listSessionPendingInputs({
            ...target,
            sessionId: expectedTarget.sessionId,
            storePath: expectedTarget.storePath,
          }),
        ).toMatchObject({ items: [{ state: "cancelled", endCause: "user-stop" }] });
      } finally {
        await drainGlobalSingletonLifecycleState("restart");
        resetSystemEventsForTest();
      }
    },
  );
});

it.for(["resume", "cancel", "membership removal"] as const)(
  "lets a conversational turn pass a parked automation before %s",
  async (action, { signal }) => {
    await withOpenClawTestState(
      { label: "session-event-provider-wait", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const scope = { agentId: "main", sessionKey: "agent:main:provider-wait" };
        const stopWaiting = new AbortController();
        const parked = createDeferred();
        const release = createDeferred();
        let allowed = false;
        const prompts: string[] = [];
        model.mockReset().mockImplementation(async (params) => {
          prompts.push(params.prompt);
          await admitModelTurn(params);
          return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
        });
        const scheduledText = "Run the scheduled report on the selected provider";
        const job: CronStoredJob = makeCronJob({
          sessionTarget: `session:${scope.sessionKey}`,
          agentId: scope.agentId,
        });
        let cron: CronService | undefined;
        let memberActive = true;
        let scheduled: ReturnType<typeof runCronSessionTurn> | undefined;
        try {
          const config = completionConfig(state.workspaceDir);
          const context = createContext([], () => config);
          const member =
            action === "membership removal" ? memberSourceCase("removed member") : undefined;
          if (member) {
            config.gateway = { ...member.cfg.gateway, openclawId: { enabled: true } };
          }
          await configureEventState(state, config);
          await replaceSessionEntry(scope, {
            sessionId: "provider-wait",
            lifecycleRevision: "original",
            permissionMode: "full",
            updatedAt: Date.now(),
          });
          if (member) {
            const { profileId, openclawIdPrincipal: principal } =
              member.operatorSource.source.snapshot;
            if (principal?.kind !== "member") {
              throw new Error("Expected a scheduled member");
            }
            linkOpenClawIdUserProfile(
              { profileId, accountId: principal.accountId, email: null },
              {},
            );
            setOpenClawIdMemberAccountLookup((id) => memberActive && id === principal.accountId);
            setOpenClawIdTunnelPrincipalLookup(() => (memberActive ? principal : undefined));
            job.operatorSource = member.operatorSource;
            job.operatorSource.executionRevision = resolveCronOperatorExecutionRevision(job);
            job.state.nextRunAtMs = Date.now() + 60_000;
            const storePath = path.join(state.stateDir, "parked-cron.json");
            await writeCronStoreSnapshot({ storePath, jobs: [job] });
            cron = new CronService({
              storePath,
              cronEnabled: true,
              defaultAgentId: scope.agentId,
              scheduler: createTestGatewayScheduler(),
              log: noopLogger,
              enqueueSystemEvent() {},
              runIsolatedAgentJob: async () => ({ status: "ok" }),
            });
            context.cron = cron;
            context.resolveGatewayContext = () => context;
            await cron.start();
          }
          const runScheduled = createScheduledGatewayRunner(member ? () => context : undefined);
          scheduled = runScheduled(() =>
            runCronSessionTurn({
              ...TEST_SCHEDULED_TURN,
              ...scope,
              cfg: config,
              job,
              text: scheduledText,
              deliveryAttemptFence: member
                ? { beforeAttempt: async () => {}, assertCurrent() {} }
                : null,
              abortSignal: AbortSignal.any([signal, stopWaiting.signal]),
              providerRunSlot: {
                tryStart: () => allowed,
                wait: async (provider, parkedSignal) => {
                  expect(provider).toBe("mock-openai");
                  parked.resolve();
                  await withinTest(release.promise, parkedSignal);
                },
              },
            }),
          );
          await withinTest(
            awaitGateBeforeSettlement(parked.promise, scheduled, "automation never parked"),
            signal,
          );
          expect(peekDeliverableSystemEventEntries(scope.sessionKey)).toEqual([]);
          const other = enqueueSessionEventForHost("Unrelated conversation turn", {
            ...scope,
            source: "task",
            expectedTarget: await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey),
            abortSignal: signal,
            deliver: false,
          });
          await expect(withinTest(other.settled, signal)).resolves.toMatchObject({
            status: "completed",
          });
          expect(prompts).toHaveLength(1);
          expect(prompts[0]).not.toContain(scheduledText);
          if (action === "cancel") {
            stopWaiting.abort();
            await expect(withinTest(scheduled, signal)).resolves.toMatchObject({
              status: "error",
              executionStarted: false,
            });
            expect(prompts).toHaveLength(1);
            expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
          } else if (member) {
            memberActive = false;
            allowed = true;
            release.resolve();
            await expect(withinTest(scheduled, signal)).resolves.toMatchObject({
              status: "error",
              executionStarted: false,
              errorClassification: { kind: "permanent" },
              error: expect.stringContaining(
                "operator authority that created this automation was refused",
              ),
            });
            expect(prompts).toHaveLength(1);
            expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
          } else {
            allowed = true;
            release.resolve();
            await expect(withinTest(scheduled, signal)).resolves.toMatchObject({
              status: "ok",
              executionStarted: true,
            });
            expect(prompts).toHaveLength(2);
            expect(prompts[1]).toContain(scheduledText);
          }
        } finally {
          allowed = true;
          release.resolve();
          await scheduled?.catch(() => {});
          if (action === "membership removal") {
            setOpenClawIdMemberAccountLookup(undefined);
            setOpenClawIdTunnelPrincipalLookup(undefined);
            cron?.stop();
            await cron?.waitForIdle();
          }
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
        }
      },
    );
  },
);

// Queue/readmission is covered by session-event-config-readmission.test.ts's
// queued Gmail and scheduled destination cases; result settlement is admission-independent.
it.for([
  { result: "progress" },
  { result: "no_change" },
  { result: "failed" },
  { result: "thrown" },
  { result: "progress", notification: "none" },
  { result: "progress", notification: "conversation" },
  { result: "no_change", notification: "conversation" },
  { result: "progress", notification: "unavailable" },
  { result: "progress", notification: "native-only" },
  { result: "progress", notification: "conversation", alias: "main-key" },
  { result: "progress", notification: "conversation", alias: "agent" },
  { result: "progress", notification: "conversation", alias: "global-main" },
  { result: "progress", notification: "other-conversation" },
  { result: "progress", messageTool: true },
  { result: "progress", messageTool: "mirror" },
] as const)(
  "settles automation $result ($notification/$messageTool/$alias) through its shared session owner",
  async (scenario, { signal }) => {
    const progress = scenario.result === "progress";
    const failed = scenario.result === "failed" || scenario.result === "thrown";
    const notification = "notification" in scenario ? scenario.notification : undefined;
    const nativeOnly = notification === "native-only";
    const otherConversation = notification === "other-conversation";
    const conversationOnly = notification === "conversation" || nativeOnly || otherConversation;
    const notificationDisabled = notification === "none";
    const unavailable = notification === "unavailable";
    const deliveryFails = unavailable || nativeOnly || otherConversation;
    const alias = "alias" in scenario ? scenario.alias : undefined;
    const globalScope = alias === "global-main";
    const result = progress ? { outcome: "progress", summary } : { outcome: "no_change" };
    await withOpenClawTestState(
      { label: "automation-shared-result", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const cfg = completionConfig(state.workspaceDir);
        if (globalScope) {
          cfg.session = { scope: "global" };
        } else if (alias === "main-key") {
          cfg.session = { mainKey: "primary" };
        } else if (alias === "agent") {
          cfg.agents = {
            ...cfg.agents,
            entries: { ...cfg.agents?.entries, ops: { workspace: state.workspaceDir } },
          };
        }
        setRuntimeConfigSnapshot(cfg);
        await state.writeConfig(cfg);
        openOpenClawStateDatabase();
        const registry = captureActivePluginRegistrySnapshot();
        const current = expectDefined(registry.activeRegistry, "active plugin registry");
        const sendText = vi
          .fn<NonNullable<ChannelOutboundAdapter["sendText"]>>()
          .mockResolvedValue({
            channel: "telegram",
            messageId: "automation-result-message",
          });
        const channels = createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "telegram" }),
              messaging: {
                normalizeTarget: (raw) => raw,
                targetResolver: { looksLikeId: (raw) => raw === "-100001" },
              },
              outbound: { deliveryMode: "direct", sendText },
            } satisfies ChannelPlugin,
          },
        ]);
        setActivePluginRegistry({
          ...current,
          channels: [
            ...current.channels.filter((entry) => entry.plugin.id !== "telegram"),
            ...(alias ? [] : channels.channels),
          ],
          channelSetups: [
            ...current.channelSetups.filter((entry) => entry.plugin.id !== "telegram"),
            ...(alias ? [] : channels.channelSetups),
          ],
        });
        const scope = {
          agentId: alias === "agent" ? "ops" : "main",
          sessionKey: globalScope
            ? "global"
            : alias === "agent"
              ? "agent:ops:main"
              : alias === "main-key"
                ? "agent:main:primary"
                : "agent:main:automation-result",
        };
        const sessionId = "automation-result-session";
        const route = { channel: "telegram", to: "-100001", accountId: "default" };
        await replaceSessionEntry(scope, {
          sessionId,
          lifecycleRevision: "original",
          permissionMode: "full",
          delivery: normalizeSessionDeliveryState({
            context: conversationOnly ? { channel: "webchat" } : route,
          }),
          updatedAt: Date.now(),
        });
        const source = otherConversation
          ? {
              agentId: "main",
              sessionKey: "agent:main:other",
              sessionId: "other-session",
              lifecycleRevision: "original",
            }
          : { ...scope, sessionId, lifecycleRevision: "original" };
        if (otherConversation) {
          await replaceSessionEntry(source, {
            sessionId: source.sessionId,
            lifecycleRevision: source.lifecycleRevision,
            updatedAt: Date.now(),
            delivery: normalizeSessionDeliveryState({ context: { channel: "webchat" } }),
          });
        }
        const job = {
          ...makeCronJob({
            id: "shared-result-job",
            agentId: scope.agentId,
            sessionTarget:
              alias === "agent"
                ? "session:agent:main:main"
                : alias === "main-key" || alias === "global-main"
                  ? "session:main"
                  : `session:${scope.sessionKey}`,
            delivery: notificationDisabled
              ? { mode: "none" }
              : {
                  mode: "announce",
                  ...(conversationOnly
                    ? {}
                    : unavailable
                      ? { channel: "missing-channel", to: "recipient" }
                      : route),
                },
            payload: {
              kind: "agentTurn",
              message: request,
              includeReasoning: true,
            },
          }),
          sourceConversation: alias ? undefined : source,
        };
        let automationRunId: string | undefined;
        model.mockReset().mockImplementation(async (params) => {
          await admitModelTurn(params);
          automationRunId = expectDefined(params.runId, "automation run id");
          await params.onBlockReply?.({
            text: "Unsettled reasoning must stay private.",
            isReasoning: true,
          });
          const tool = createCronTool({
            config: params.config,
            runId: automationRunId,
            agentId: params.agentId,
            agentSessionKey: params.sessionKey,
            selfRemoveOnlyJobId: job.id,
          });
          await tool.execute("result", {
            action: "record_result",
            ...result,
          });
          const finalPayload = nativeOnly
            ? {
                channelData: {
                  discord: {
                    embeds: [{ title: "Report ready", description: "Native report body" }],
                  },
                },
              }
            : { text: summary };
          if ("messageTool" in scenario && scenario.messageTool === "mirror") {
            setReplyPayloadMetadata(finalPayload, {
              sourceReplyTranscriptMirror: {
                ...scope,
                text: finalPayload.text,
                idempotencyKey: `source-result:${automationRunId}`,
              },
            });
          }
          if (scenario.result === "thrown") {
            throw new Error(failure);
          }
          if (failed) {
            return {
              payloads: [{ text: failure, isError: true }],
              meta: { durationMs: 1, error: { kind: "retry_limit", message: failure } },
            };
          }
          return {
            payloads: [{ text: "Reasoning for the report.", isReasoning: true }, finalPayload],
            meta: { durationMs: 1 },
            ...("messageTool" in scenario
              ? {
                  didSendViaMessagingTool: true,
                  messagingToolSentTargets: [{ tool: "message", provider: "telegram", ...route }],
                }
              : {}),
          };
        });
        try {
          const outcome = await runGatewayCronSessionEvent(
            {
              occurrence: TEST_SCHEDULED_OCCURRENCE,
              job,
              text: request,
              admissionSource: "operator-schedule",
              deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent() {} },
              abortSignal: signal,
              assertCurrent() {},
            },
            createGatewayCronTargetResolver(state.env, { warn() {} }).resolveCronTarget,
          );
          expect(outcome, outcome.error).toMatchObject({
            status: failed ? "error" : "ok",
            executionStarted: true,
            ...(failed ? { error: expect.stringContaining(failure) } : {}),
          });
          expect(outcome.result).toEqual(result);
          const settled = expectDefined(
            await readSessionEntryInWorker(scope),
            "settled shared session",
          );
          expect(settled.sessionId).toBe(sessionId);
          expect(settled.pendingFinalDelivery).toBeUndefined();
          expect(
            peekSystemEventEntries(resolveSystemEventQueueKey(scope.sessionKey, scope.agentId)),
          ).toEqual([]);
          const messages = (await loadTranscriptEvents({ ...scope, sessionId })).map(
            readTranscriptEventMessage,
          );
          const facts = messages.filter(
            (message) =>
              message?.model === "automation-result" ||
              message?.idempotencyKey === `source-result:${automationRunId}`,
          );
          expect(facts.map((fact) => fact?.content)).toEqual(
            progress && !nativeOnly ? [[{ type: "text", text: summary }]] : [],
          );
          if (progress) {
            expect(outcome).toMatchObject({
              summary,
              delivered: !notificationDisabled && !deliveryFails,
            });
            expect(Boolean(outcome.deliveryError)).toBe(unavailable || otherConversation);
            expect(
              resolveAdmittedCronCompletionStatus(
                job,
                "ok",
                notificationDisabled
                  ? "not-requested"
                  : outcome.delivered
                    ? "delivered"
                    : "not-delivered",
                outcome.deliverySuppressionReason,
              ),
            ).toBe(deliveryFails ? "failed" : "succeeded");
            if (conversationOnly && !nativeOnly && !otherConversation) {
              expect(outcome.delivery).toMatchObject({ fallbackUsed: true, delivered: true });
              expect(outcome.delivery?.messageToolSentTo).toBeUndefined();
            }
            expect(sendText.mock.calls.map(([sent]) => sent.text)).toEqual(
              "notification" in scenario || "messageTool" in scenario
                ? []
                : ["Reasoning for the report.", summary],
            );
          } else if (scenario.result === "no_change") {
            expect(outcome).toMatchObject({
              delivered: false,
              deliveryAttempted: false,
              summary: undefined,
            });
            expect(sendText).not.toHaveBeenCalled();
            expect(
              resolveAdmittedCronCompletionStatus(
                job,
                "ok",
                "not-delivered",
                outcome.deliverySuppressionReason,
              ),
            ).toBe("succeeded");
          } else if (scenario.result === "failed") {
            expect(sendText.mock.calls.some(([sent]) => sent.text.includes(failure))).toBe(true);
          }
        } finally {
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
          restoreActivePluginRegistrySnapshot(registry);
        }
      },
    );
  },
);

it.for([
  "user",
  "caller",
  "auth-revoked",
  "restart",
  "superseded",
  "frozen-superseded",
  "timeout",
  "stalled",
] as const)(
  "preserves controller-owned %s through the scheduled event receipt",
  async (reason, { signal }) => {
    await withOpenClawTestState(
      { label: "automation-owned-stop", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const cfg = completionConfig(state.workspaceDir);
        setRuntimeConfigSnapshot(cfg);
        await state.writeConfig(cfg);
        openOpenClawStateDatabase();
        const scope = { agentId: "main", sessionKey: "agent:main:automation-owned-stop" };
        await replaceSessionEntry(scope, {
          sessionId: "automation-owned-stop-session",
          updatedAt: Date.now(),
          permissionMode: "full",
        });
        model.mockReset().mockImplementation(async (params) => {
          await admitModelTurn(params);
          const owner = expectDefined(params.replyOperation, "scheduled reply owner");
          if (reason === "stalled") {
            owner.abortForStall();
            expect(owner.result).toMatchObject({ kind: "failed", code: "run_stalled" });
          } else if (reason === "superseded" || reason === "frozen-superseded") {
            if (reason === "frozen-superseded") {
              owner.freezeAbort();
            }
            owner.supersede();
            expect(owner.abortSignal.aborted).toBe(reason !== "frozen-superseded");
          } else if (reason === "user") {
            owner.abortByUser();
          } else if (reason === "auth-revoked") {
            owner.abort(createChatAbortSignalReason("auth-revoked"));
          } else {
            owner.abort(
              reason === "timeout"
                ? new DOMException("deadline", "TimeoutError")
                : reason === "restart"
                  ? createAgentRunRestartAbortError()
                  : new DOMException("caller stopped", "AbortError"),
            );
            expect(owner.result).toMatchObject({ kind: "aborted" });
          }
          return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
        });
        const startedAt = Date.now();
        const job = makeCronJob({
          id: "owned-stop-job",
          agentId: "main",
          sessionTarget: `session:${scope.sessionKey}`,
          schedule: { kind: "at", at: new Date(startedAt).toISOString() },
          state: { nextRunAtMs: startedAt },
          delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: "Wait for cancellation." },
        });
        try {
          const outcome = await runGatewayCronSessionEvent(
            {
              occurrence: TEST_SCHEDULED_OCCURRENCE,
              job,
              text: "Wait for cancellation.",
              admissionSource: "operator-schedule",
              deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent() {} },
              abortSignal: signal,
              assertCurrent() {},
            },
            createGatewayCronTargetResolver(state.env, { warn() {} }).resolveCronTarget,
          );
          expect(outcome).toMatchObject({ status: "error", executionStarted: true });
          if (reason === "timeout" || reason === "stalled" || reason === "caller") {
            expect(outcome.errorClassification).toEqual({ kind: "reason", reason: "timeout" });
          } else if (reason === "auth-revoked") {
            expect(outcome.errorClassification).toEqual({
              kind: "reason",
              reason: "auth_permanent",
            });
          } else {
            expect(outcome.errorClassification).toEqual({ kind: "aborted" });
            expect(outcome.interruptedByRestart).toBe(reason === "restart");
          }
          expect(model).toHaveBeenCalledOnce();
          const cron = createCronRegressionState({
            storePath: state.statePath("cron", "jobs.json"),
            runIsolatedAgentJob: async () => ({ status: "ok" }),
          });
          const deferredNotifications: DeferredCronNotifications = [];
          const endedAt = Date.now();
          applyJobResult(
            cron,
            job,
            {
              ...outcome,
              startedAt,
              endedAt,
              errorReason: resolveCronRunErrorReason(
                outcome.error,
                outcome.provider,
                outcome.errorClassification,
              ),
            },
            { deferredNotifications },
          );
          const retry = ["timeout", "stalled", "caller", "restart"].includes(reason);
          expect(job.enabled).toBe(retry);
          if (retry) {
            expect(job.state.nextRunAtMs).toBe(endedAt + (reason === "restart" ? 2_000 : 30_000));
            expect(job.state.autoDisabled).toBeUndefined();
          }
          // A run failure records no auto-disable notice; this job has no alert route.
          expect(deferredNotifications).toEqual([]);
        } finally {
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
        }
      },
    );
  },
);

/** What remote skill discovery throws while the workspace node is absent. */
function workspaceDisconnect(nodeCommandDispatched?: boolean) {
  return new WorkspaceAccessUnavailableError("Remote workspace skill discovery failed", {
    cause: new GatewayClientRequestError({
      code: "UNAVAILABLE",
      message: "node not connected",
      details: {
        code: "NOT_CONNECTED",
        nodeError: { code: "NOT_CONNECTED", message: "node not connected" },
        ...(nodeCommandDispatched === undefined ? {} : { nodeCommandDispatched }),
      },
    }),
  });
}

/** Run one restart input; `node` decides each pre-admission skill discovery attempt. */
async function runRestartEvent(
  label: string,
  signal: AbortSignal,
  node: (attempt: number) => void,
) {
  return await withOpenClawTestState({ label, env: { OPENCLAW_TEST_FAST: "0" } }, async (state) => {
    await configureEventState(state, completionConfig(state.workspaceDir));
    const target = { agentId: "main", sessionKey: `agent:main:dashboard:${label}` };
    await replaceSessionEntry(target, {
      sessionId: label,
      lifecycleRevision: "original",
      permissionMode: "full",
      updatedAt: Date.now(),
    });
    const discover = sessionUpdates.ensureSkillSnapshot;
    using skills = vi
      .spyOn(sessionUpdates, "ensureSkillSnapshot")
      .mockImplementation(async (params) => {
        node(skills.mock.calls.length);
        return await discover(params);
      });
    model.mockReset().mockImplementation(async (params) => {
      await startEmbeddedTurn(params, "restart turn");
      return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
    });
    try {
      const receipt = enqueueSessionEventForHost("Resume required work", {
        ...target,
        source: "restart",
        expectedTarget: await captureSessionEventTargetForHost(target.agentId, target.sessionKey),
        abortSignal: signal,
        deliver: false,
      });
      const [outcome, accepted] = await withinTest(
        Promise.all([receipt.settled, receipt.accepted]),
        signal,
      );
      const discoveries = skills.mock.calls.length;
      return { outcome, accepted, discoveries, runs: model.mock.calls.length };
    } finally {
      await drainGlobalSingletonLifecycleState("restart");
      resetSystemEventsForTest();
    }
  });
}

it("retries an undispatched restart input until its workspace node reconnects", async ({
  signal,
}) => {
  const result = await runRestartEvent("workspace-reconnect", signal, (attempt) => {
    if (attempt === 1) {
      throw workspaceDisconnect(false);
    }
  });
  expect(result.outcome, result.outcome.error).toMatchObject({
    status: "completed",
    executionStarted: true,
  });
  expect(result.accepted).toEqual({ ok: true });
  expect(result).toMatchObject({ discoveries: 2, runs: 1 });
});

it.for([
  { case: "dispatched", nodeCommandDispatched: true },
  { case: "ambiguous", nodeCommandDispatched: undefined },
])(
  "keeps a $case workspace disconnect terminal",
  async ({ case: label, nodeCommandDispatched }, { signal }) => {
    const result = await runRestartEvent(`workspace-${label}`, signal, () => {
      throw workspaceDisconnect(nodeCommandDispatched);
    });
    expect(result.outcome).toMatchObject({ status: "failed", executionStarted: false });
    expect(result.accepted).toMatchObject({ ok: false });
    expect(result).toMatchObject({ discoveries: 1, runs: 0 });
  },
);

it("stops retrying an undispatched restart input after the reconnect window", async ({
  signal,
}) => {
  const now = Date.now.bind(Date);
  let skewMs = 0;
  using clock = vi.spyOn(Date, "now").mockImplementation(() => now() + skewMs);
  const result = await runRestartEvent("workspace-deadline", signal, (attempt) => {
    // The window opens at the first attempt: one retry inside it, none after it.
    skewMs += attempt === 1 ? 30_000 : 31_000;
    throw workspaceDisconnect(false);
  });
  expect(result.outcome).toMatchObject({ status: "failed", executionStarted: false });
  expect(result.outcome.error).toContain("Remote workspace skill discovery failed");
  expect(result).toMatchObject({ discoveries: 2, runs: 0 });
  expect(clock).toHaveBeenCalled();
});

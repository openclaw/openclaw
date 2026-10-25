import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
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
import { createCronTool } from "../../agents/tools/cron-tool.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-writable.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../../cron/scheduled-occurrence.test-support.js";
import { runCronSessionTurn } from "../../cron/session-run.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";

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

it.for([
  { admission: "immediate", result: "progress" },
  { admission: "queued", result: "progress" },
  { admission: "immediate", result: "no_change" },
  { admission: "queued", result: "no_change" },
  { admission: "queued", result: "failed" },
  { admission: "immediate", result: "progress", notification: "none" },
  { admission: "immediate", result: "progress", messageTool: true },
  { admission: "immediate", result: "progress", messageTool: "mirror" },
] as const)(
  "settles a $admission automation $result ($notification/$messageTool) through its shared session owner",
  async (scenario, { signal }) => {
    const progress = scenario.result === "progress";
    const failed = scenario.result === "failed";
    const result = progress ? { outcome: "progress", summary } : { outcome: "no_change" };
    const waitForGate = (gate: Promise<void>, settled: Promise<unknown>, message: string) =>
      withinTest(awaitGateBeforeSettlement(gate, settled, message), signal);
    await withOpenClawTestState(
      { label: "automation-shared-result", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const cfg = completionConfig(state.workspaceDir);
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
            ...channels.channels,
          ],
          channelSetups: [
            ...current.channelSetups.filter((entry) => entry.plugin.id !== "telegram"),
            ...channels.channelSetups,
          ],
        });
        const scope = { agentId: "main", sessionKey: "agent:main:automation-result" };
        const sessionId = "automation-result-session";
        const route = { channel: "telegram", to: "-100001", accountId: "default" };
        await replaceSessionEntry(scope, {
          sessionId,
          lifecycleRevision: "original",
          permissionMode: "full",
          delivery: normalizeSessionDeliveryState({ context: route }),
          updatedAt: Date.now(),
        });
        const job = makeCronJob({
          id: "shared-result-job",
          sessionTarget: `session:${scope.sessionKey}`,
          delivery: "notification" in scenario ? { mode: "none" } : { mode: "announce", ...route },
          payload: {
            kind: "agentTurn",
            message: request,
            includeReasoning: true,
          },
        });
        const firstStarted = createDeferred();
        const releaseFirst = createDeferred();
        const queued = createDeferred();
        let nativeCalls = 0;
        let automationRunId: string | undefined;
        model.mockReset().mockImplementation(async (params) => {
          await admitModelTurn(params);
          nativeCalls++;
          if (scenario.admission === "queued" && nativeCalls === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
            return {
              payloads: [],
              meta: { durationMs: 1, terminalReply: { disposition: "silent" } },
            };
          }
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
          const finalPayload = { text: summary };
          if ("messageTool" in scenario && scenario.messageTool === "mirror") {
            setReplyPayloadMetadata(finalPayload, {
              sourceReplyTranscriptMirror: {
                ...scope,
                text: finalPayload.text,
                idempotencyKey: `source-result:${automationRunId}`,
              },
            });
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
        let first: ReturnType<typeof enqueueSessionEventForHost> | undefined;
        let scheduled: ReturnType<typeof runCronSessionTurn> | undefined;
        try {
          if (scenario.admission === "queued") {
            first = enqueueSessionEventForHost("Hold this session until the automation queues.", {
              ...scope,
              source: "task",
              expectedTarget: await captureSessionEventTargetForHost(
                scope.agentId,
                scope.sessionKey,
              ),
              abortSignal: signal,
              deliver: false,
            });
            await waitForGate(firstStarted.promise, first.settled, "holding turn never started");
          }
          scheduled = runCronSessionTurn({
            occurrence: TEST_SCHEDULED_OCCURRENCE,
            ...scope,
            cfg,
            job,
            text: request,
            admissionSource: "operator-schedule",
            deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent() {} },
            abortSignal: signal,
            assertCurrent() {},
            onLaneWait(info) {
              if (info?.waiting) {
                queued.resolve();
              }
            },
          });
          if (first) {
            await waitForGate(queued.promise, scheduled, "automation never entered the queue");
            expect(automationRunId).toBeUndefined();
            releaseFirst.resolve();
            await expect(first.settled).resolves.toMatchObject({ status: "completed" });
          }
          const outcome = await scheduled;
          expect(outcome, outcome.error).toMatchObject({
            status: failed ? "error" : "ok",
            executionStarted: true,
            ...(failed ? { error: failure } : {}),
          });
          expect(outcome.result).toEqual(result);
          expect(nativeCalls).toBe(scenario.admission === "queued" ? 2 : 1);
          const settled = expectDefined(
            await readSessionEntryInWorker(scope),
            "settled shared session",
          );
          expect(settled.sessionId).toBe(sessionId);
          expect(settled.pendingFinalDelivery).toBeUndefined();
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
          const messages = (await loadTranscriptEvents({ ...scope, sessionId })).map(
            readTranscriptEventMessage,
          );
          const facts = messages.filter(
            (message) =>
              message?.model === "automation-result" ||
              message?.idempotencyKey === `source-result:${automationRunId}`,
          );
          expect(facts.map((fact) => fact?.content)).toEqual(
            progress ? [[{ type: "text", text: summary }]] : [],
          );
          if (progress) {
            expect(outcome).toMatchObject({ summary, delivered: !("notification" in scenario) });
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
          } else {
            expect(sendText.mock.calls.some(([sent]) => sent.text.includes(failure))).toBe(true);
          }
        } finally {
          releaseFirst.resolve();
          first?.cancel();
          await Promise.allSettled([first?.settled, scheduled]);
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
          restoreActivePluginRegistrySnapshot(registry);
        }
      },
    );
  },
);

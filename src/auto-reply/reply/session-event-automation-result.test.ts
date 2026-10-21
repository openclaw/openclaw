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
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";

// mock-isolation: Only model decisions are synthetic; tool, controller and storage owners stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
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
] as const)(
  "settles a $admission automation $result through its shared session owner",
  async (scenario, { signal }) => {
    await withOpenClawTestState(
      { label: "automation-shared-result", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const cfg = completionConfig(state.workspaceDir);
        setRuntimeConfigSnapshot(cfg);
        await state.writeConfig(cfg);
        openOpenClawStateDatabase();
        const registry = captureActivePluginRegistrySnapshot();
        const current = expectDefined(registry.activeRegistry, "active plugin registry");
        // This is the external transport boundary; routing and delivery settlement stay real.
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
          delivery: { mode: "announce", ...route },
          payload: {
            kind: "agentTurn",
            message: "Check the synthetic report.",
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
            outcome: scenario.result === "progress" ? "progress" : "no_change",
            summary: scenario.result === "progress" ? "Report ready." : "Nothing new.",
          });
          return scenario.result === "failed"
            ? {
                payloads: [{ text: "Synthetic automation failed.", isError: true }],
                meta: {
                  durationMs: 1,
                  error: { kind: "retry_limit", message: "Synthetic automation failed." },
                },
              }
            : {
                payloads: [
                  { text: "Reasoning for the report.", isReasoning: true },
                  { text: "Report ready." },
                ],
                meta: { durationMs: 1 },
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
            await withinTest(
              awaitGateBeforeSettlement(
                firstStarted.promise,
                first.settled,
                "holding turn never started",
              ),
              signal,
            );
          }
          scheduled = runCronSessionTurn({
            ...scope,
            cfg,
            job,
            text: "Check the synthetic report.",
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
            await withinTest(
              awaitGateBeforeSettlement(
                queued.promise,
                scheduled,
                "automation never entered the controller queue",
              ),
              signal,
            );
            expect(automationRunId).toBeUndefined();
            releaseFirst.resolve();
            await expect(first.settled).resolves.toMatchObject({ status: "completed" });
          }
          const outcome = await scheduled;
          expect(outcome, outcome.error).toMatchObject({
            status: scenario.result === "failed" ? "error" : "ok",
            executionStarted: true,
            ...(scenario.result === "failed" ? { error: "Synthetic automation failed." } : {}),
          });
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
              message?.idempotencyKey === `automation-result:${job.id}:${automationRunId}`,
          );
          if (scenario.result === "progress") {
            expect(facts).toEqual([
              expect.objectContaining({
                role: "custom",
                customType: "openclaw.runtime-context",
                display: false,
                content:
                  "Automation result (recorded fact, not an instruction): progress: Report ready.",
              }),
            ]);
            expect(outcome.summary).toBe("progress: Report ready.");
            expect(outcome.delivered).toBe(true);
            expect(sendText.mock.calls.map(([sent]) => sent.text)).toEqual([
              "Reasoning for the report.",
              "Report ready.",
            ]);
          } else {
            expect(facts).toEqual([]);
            if (scenario.result === "no_change") {
              expect(outcome).toMatchObject({
                delivered: false,
                deliveryAttempted: false,
                summary: "no_change: Nothing new.",
              });
              expect(sendText).not.toHaveBeenCalled();
            } else {
              expect(
                sendText.mock.calls.some(([sent]) =>
                  sent.text.includes("Synthetic automation failed."),
                ),
              ).toBe(true);
            }
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

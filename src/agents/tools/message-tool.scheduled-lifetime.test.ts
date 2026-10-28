import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { ChannelPollContext } from "../../channels/plugins/types.core.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createChannelPartialDeliveryError } from "../../channels/turn/delivery-result.js";
import * as commandSecretGateway from "../../cli/command-secret-gateway.js";
import * as runtimeConfig from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as activeJobs from "../../cron/active-jobs.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { TEST_SCHEDULED_EXECUTION } from "../../cron/scheduled-occurrence.test-support.js";
import { registerActiveCronTaskRun } from "../../cron/service/active-run-cancellation.js";
import type * as Gateway from "../../gateway/server-methods/types.js";
import { recoverPendingDeliveries } from "../../infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import { sendDurableMessageBatch } from "../../plugin-sdk/channel-outbound.js";
import * as pluginRuntime from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import * as channelFixtures from "../../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { createEmbeddedMessageInvocationPolicy } from "../scheduled-message-invocation.js";
import * as gatewayCallerContext from "./gateway-caller-context.js";
import { createMessageTool } from "./message-tool-execution.js";
import {
  messageGatewayContext,
  resolvedMessageSecrets,
} from "./message-tool-execution.test-support.js";

const settled = { status: "settled", partialDelivery: false };
function delivered(messageId: string, withSettlement = true) {
  const result = { messageId };
  return { details: withSettlement ? { result, messageDelivery: settled } : { result } };
}
function actionResult(details: Record<string, unknown> = { ok: true }) {
  return { content: [{ type: "text" as const, text: '{"ok":true}' }], details };
}
const partialDelivery = { ok: false, deliveryStatus: "partial_failed", sentBeforeError: true };
const partiallyDelivered = (messageId: string) => ({
  details: { ...partialDelivery, result: { messageIds: [messageId] } },
});
const sent = delivered("message-1", false);
const sentViaGateway = delivered("message-1");
const pollSent = delivered("poll-1");
const actionDone = { details: { ok: true } };
const connection = (gatewayUrl: string, gatewayToken: string) => ({ gatewayUrl, gatewayToken });
const partialError = (error: unknown, messageId: string) =>
  createChannelPartialDeliveryError(error, { messageIds: [messageId], visibleReplySent: true });

it.each([
  ["provider", "send", "direct", "accepted", sent],
  ["target", "send", "direct", "rejected", {}],
  ["action", "set-presence", "direct", "accepted", actionDone],
  ["unconfirmed-action", "set-presence", "gateway", "rejected", {}],
  ["retry", "send", "direct", "rejected", {}],
  ["retry", "send", "gateway", "rejected", {}],
  ["provider", "send", "gateway", "accepted", sentViaGateway],
  ["generic-retry", "reply", "direct", "rejected", {}],
  ["generic-retry", "reply", "gateway", "rejected", {}],
  ["poll-retry", "poll", "gateway", "rejected", {}],
  ["poll-provider", "poll", "gateway", "accepted", pollSent],
  ["multipart", "send", "direct", "partial", partiallyDelivered("message-1")],
  ["unbound", "send", "gateway", "rejected", {}],
  ["partial-action", "set-presence", "direct", "partial", partiallyDelivered("message-action")],
  ["partial-action", "set-presence", "gateway", "partial", partiallyDelivered("message-action")],
  ["config", "send", "gateway", "accepted", sentViaGateway],
  ["poll-partial", "poll", "direct", "partial", partiallyDelivered("poll-partial")],
  ["poll-partial", "poll", "gateway", "partial", partiallyDelivered("poll-partial")],
] as const)(
  "settles %s revocation during %s via %s as %s",
  async (revokeAt, action, deliveryMode, outcome, expected) => {
    const accepted = outcome !== "rejected";
    const at = (...stages: string[]) => stages.includes(revokeAt);
    const viaGateway = deliveryMode === "gateway";
    const existingGatewayJob = revokeAt === "provider" && deliveryMode === "gateway";
    const revokedError = "cron message action authority is no longer active";
    const laterError =
      revokeAt === "poll-provider"
        ? undefined
        : revokeAt === "action"
          ? "Message send aborted"
          : revokedError;
    const registry = pluginRuntime.captureActivePluginRegistrySnapshot();
    const state = await createOpenClawTestState();
    const source = new AbortController();
    const boundaryEntered = createDeferred();
    const releaseBoundary = createDeferred();
    const pauseAtBoundary = async (when: boolean) => {
      if (when) {
        boundaryEntered.resolve();
        await releaseBoundary.promise;
      }
    };
    const jobId = "scheduled-message-lifetime";
    const runId = "scheduled-message-lifetime-run";
    const sessionKey = `agent:main:cron:${jobId}:run:${runId}`;
    const scheduledToolPolicy = { version: 1, mode: "trusted" } as const;
    const identity = { agentId: "main", runId, sessionId: runId };
    const runOptions = { ...identity, sessionKey, scheduledToolPolicy };
    const marker = activeJobs.markCronJobActive(jobId, {
      isMessageActionAuthorityCurrent: () => true,
    });
    const releaseCancellation = registerActiveCronTaskRun({
      runId,
      controller: source,
      activeJobMarker: marker,
    });
    let pending: ReturnType<ReturnType<typeof createMessageTool>["execute"]> | undefined;
    let admission: ReturnType<typeof prepareCronRunAdmission> | undefined;
    let gatewayDispatch: ReturnType<typeof vi.fn<Gateway.GatewayRequestHandler>> | undefined;
    try {
      const config: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
        tools: { allow: ["message"] },
        channels: {
          discord:
            revokeAt === "config"
              ? { accounts: { admitted: { token: "admitted-token" } } }
              : { token: "synthetic-token" },
        },
        ...(revokeAt === "unbound"
          ? { gateway: { mode: "remote", remote: { url: "wss://example.invalid" } } }
          : {}),
      };
      let currentConfig = config;
      runtimeConfig.setRuntimeConfigSnapshot(config, config);
      let sendCount = 0;
      const mutations: string[] = [];
      const gatewayFields: [unknown, unknown, unknown, unknown][] = [];
      const pollRequests: string[] = [];
      const sendText = vi.fn(async ({ onPlatformSendDispatch }: ChannelOutboundContext) => {
        sendCount++;
        await pauseAtBoundary(
          at("provider", "retry", "generic-retry") || (revokeAt === "multipart" && sendCount === 1),
        );
        if (at("retry", "generic-retry")) {
          await onPlatformSendDispatch?.();
        }
        return { channel: "discord", messageId: `message-${sendCount}` };
      });
      const listTargetsLive = async () => {
        await pauseAtBoundary(revokeAt === "target");
        return [{ kind: "group" as const, id: "channel:100000000000000001", name: "alerts" }];
      };
      const sendPoll = vi.fn(async ({ assertDirectAdapterHandoff }: ChannelPollContext) => {
        pollRequests.push("initial");
        await pauseAtBoundary(at("poll-provider", "poll-retry", "poll-partial"));
        if (at("poll-retry", "poll-partial")) {
          try {
            assertDirectAdapterHandoff?.();
          } catch (error) {
            if (revokeAt === "poll-partial") {
              throw partialError(error, "poll-partial");
            }
            throw error;
          }
          pollRequests.push("retry");
        }
        return { channel: "discord", messageId: "poll-1" };
      });
      const plugin: ChannelPlugin = {
        ...channelFixtures.createChannelTestPluginBase({
          id: "discord",
          config:
            revokeAt === "config"
              ? {
                  listAccountIds: (candidate) =>
                    Object.keys(candidate.channels?.discord?.accounts ?? {}),
                  defaultAccountId: () => "admitted",
                  resolveAccount: (candidate, accountId) =>
                    candidate.channels?.discord?.accounts?.[accountId ?? "admitted"] ?? {},
                }
              : undefined,
        }),
        actions: {
          describeMessageTool: () => ({ actions: ["send", "poll", "reply", "set-presence"] }),
          prepareSendPayload: ({ payload }) => payload,
          supportsAction: ({ action: requested }) => ["reply", "set-presence"].includes(requested),
          resolveExecutionMode: () => (viaGateway ? "gateway" : "local"),
          handleAction: async (ctx) => {
            const { action: requestedAction, params, gateway } = ctx;
            if (requestedAction === "reply") {
              const result = await sendDurableMessageBatch({
                cfg: ctx.cfg,
                channel: "discord",
                to: "channel:100000000000000001",
                payloads: [{ text: "generic" }],
                durability: "required",
                deliveryRetryOwner: ctx.deliveryRetryOwner,
                onPlatformSendDispatch: ctx.onPlatformSendDispatch,
                assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
                skipQueue: ctx.skipQueue,
              });
              if (result.status === "failed" || result.status === "partial_failed") {
                throw result.error;
              }
              return actionResult();
            }
            if (requestedAction !== "set-presence") {
              throw new Error(`Unexpected plugin action: ${requestedAction}`);
            }
            if (revokeAt === "action") {
              gatewayFields.push([
                params.gatewayUrl,
                params.gatewayToken,
                gateway?.url,
                gateway?.token,
              ]);
            }
            mutations.push(requestedAction);
            await pauseAtBoundary(at("action", "unconfirmed-action", "partial-action"));
            if (revokeAt === "partial-action") {
              try {
                await ctx.onPlatformSendDispatch?.();
              } catch (error) {
                throw partialError(error, "message-action");
              }
            }
            return actionResult(
              revokeAt === "unconfirmed-action" ? { channel: "discord" } : undefined,
            );
          },
        },
        outbound: {
          deliveryMode,
          sendText,
          sendPoll,
          chunker: revokeAt === "multipart" ? (text) => text.split(" ") : undefined,
          chunkerMode: revokeAt === "multipart" ? "text" : undefined,
        },
        directory: {
          listGroupsLive: listTargetsLive,
          listPeersLive: listTargetsLive,
        },
      };
      pluginRuntime.setActivePluginRegistry(
        channelFixtures.createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
      );

      let gatewayContext: Gateway.GatewayRequestContext | undefined;
      if (viaGateway && revokeAt !== "unbound") {
        const { sendHandlers } = await import("../../gateway/server-methods/send.js");
        const method = "message.action";
        gatewayDispatch = vi.fn(sendHandlers[method] as Gateway.GatewayRequestHandler);
        gatewayContext = messageGatewayContext(() => currentConfig, gatewayDispatch, {
          dedupe: new Map(),
        });
      }
      const prepareAdmission = () =>
        prepareCronRunAdmission({
          scheduledExecution: TEST_SCHEDULED_EXECUTION,
          deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
          cfg: config,
          ...runOptions,
          jobId,
          toolsAllow: ["message"],
        });
      admission = gatewayContext
        ? withPluginRuntimeGatewayContextResolver(() => gatewayContext, prepareAdmission)
        : prepareAdmission();
      const admitted = await admission.preparedRunAdmission.admit("embedded");
      activeJobs.bindCronJobAdmittedRun(marker, admitted, source.signal);
      const gatewayCaller = gatewayContext
        ? gatewayCallerContext.createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: "main",
            sessionKey,
            approvalSignals: [source.signal],
          })
        : undefined;
      const catalog: ReturnType<typeof createMessageTool>[] = [];
      const invocationPolicy = createEmbeddedMessageInvocationPolicy({
        config,
        capabilityProfile: resolveConversationCapabilityProfile({ config, ...runOptions }),
        runtimeProfileAlsoAllow: ["message"],
        toolSearchControlAllowlist: [],
        scheduledToolPolicy,
        catalog: () => ({ tools: catalog }),
        isAvailable: () => catalog.some((tool) => tool.name === "message"),
      });
      vi.spyOn(commandSecretGateway, "resolveCommandSecretRefsViaGateway").mockImplementation(
        async ({ config: resolvedConfig }) => {
          await pauseAtBoundary(revokeAt === "config");
          return resolvedMessageSecrets(resolvedConfig);
        },
      );
      const tool = createMessageTool({
        config,
        ...identity,
        agentSessionKey: sessionKey,
        agentAccountId: "default",
        messageActionTurnCapability: admission.messageActionTurnCapability,
        admitScheduledInvocation: invocationPolicy.admit,
      });
      catalog.push(tool);
      const invoke = <T>(run: () => Promise<T>) =>
        gatewayCaller
          ? gatewayCallerContext.withGatewayToolCallerIdentity(gatewayCaller, run)
          : run();
      const sameHostConnection = connection("ws://127.0.0.1:18789", "same-host-token");
      const defaultConnection =
        revokeAt === "action"
          ? connection("wss://legacy.example.invalid/discarded-path", "legacy-token")
          : revokeAt === "provider" && deliveryMode === "direct"
            ? sameHostConnection
            : undefined;
      const target = revokeAt === "target" ? "alerts" : "channel:100000000000000001";
      const requests = {
        send: { target, message: revokeAt === "multipart" ? "first second" : "first" },
        reply: { target, message: "generic" },
        poll: { target, pollQuestion: "Ship?", pollOption: ["Yes", "No"] },
        "set-presence": {},
      };
      const args = {
        action,
        channel: "discord",
        ...requests[action],
        ...(revokeAt === "config" ? { accountId: "admitted" } : {}),
      };
      const execute = (callId: string, gatewayConnection = defaultConnection) =>
        invoke(() => tool.execute(callId, { ...args, ...gatewayConnection }, source.signal));

      if (existingGatewayJob) {
        await expect(execute("existing-job-message", sameHostConnection)).rejects.toThrow(
          "Scheduled message actions require the active bound Gateway. Remove per-call gatewayUrl and gatewayToken fields and retry.",
        );
        expect(gatewayDispatch).not.toHaveBeenCalled();
      }
      if (revokeAt === "unbound") {
        await expect(execute("configured-remote")).rejects.toThrow(
          "Scheduled message actions require an active bound Gateway",
        );
        expect(sendText).not.toHaveBeenCalled();
        return;
      }

      pending = execute(existingGatewayJob ? "existing-job-message" : "accepted-before-revocation");
      void pending.catch(() => undefined);
      await withTestTimeout(
        Promise.race([
          boundaryEntered.promise,
          pending.then(() => {
            throw new Error("Scheduled message action completed before its provider boundary");
          }),
        ]),
        5000,
        "Scheduled provider boundary not reached",
      );
      if (revokeAt === "config") {
        currentConfig = {
          ...config,
          channels: { discord: { accounts: { replacement: { token: "replacement-token" } } } },
        };
        runtimeConfig.setRuntimeConfigSnapshot(currentConfig, currentConfig);
        releaseBoundary.resolve();
        await expect(pending).resolves.toMatchObject(expected);
        expect(sendText).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ cfg: config, accountId: "admitted" }),
        );
        return;
      }
      if (revokeAt === "action") {
        activeJobs.requestActiveCronJobCancellation(jobId, "Cron job removed by operator.");
      } else {
        activeJobs.noteActiveCronJobMessageActionAuthorityMutation(jobId);
      }
      releaseBoundary.resolve();

      if (accepted) {
        await expect(pending).resolves.toMatchObject(expected);
      } else {
        await expect(pending).rejects.toThrow(
          viaGateway && revokeAt !== "unconfirmed-action"
            ? "agent runtime authority is no longer active"
            : revokedError,
        );
      }
      await expect(execute("after-revocation")).rejects.toThrow(laterError);
      const sendAttempts = at("provider", "retry", "generic-retry", "multipart") ? 1 : 0;
      const sendReceipt = [revokeAt === "generic-retry" ? "generic" : "first", undefined];
      expect(sendText.mock.calls.map(([ctx]) => [ctx.text, ctx.deliveryQueueId])).toEqual(
        sendAttempts ? [sendReceipt] : [],
      );
      expect({ mutations, gatewayFields, pollRequests }).toEqual({
        mutations: at("action", "unconfirmed-action", "partial-action") ? [action] : [],
        gatewayFields: revokeAt === "action" ? [[undefined, undefined, undefined, undefined]] : [],
        pollRequests: action === "poll" ? ["initial"] : [],
      });
      if (at("retry", "generic-retry", "multipart")) {
        expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
        const replay = vi.fn();
        await recoverPendingDeliveries({
          deliver: replay,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          cfg: config,
          stateDir: state.stateDir,
        });
        expect(replay).not.toHaveBeenCalled();
      }
    } finally {
      source.abort();
      releaseBoundary.resolve();
      await pending?.catch(() => undefined);
      vi.restoreAllMocks();
      admission?.close();
      releaseCancellation?.();
      activeJobs.clearCronJobActive(jobId, marker);
      pluginRuntime.restoreActivePluginRegistrySnapshot(registry);
      runtimeConfig.clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  },
);

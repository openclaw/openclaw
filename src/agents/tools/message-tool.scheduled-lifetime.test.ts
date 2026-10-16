import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { ChannelPollContext } from "../../channels/plugins/types.core.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createChannelPartialDeliveryError } from "../../channels/turn/delivery-result.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindCronJobAdmittedRun,
  clearCronJobActive,
  markCronJobActive,
  noteActiveCronJobMessageActionAuthorityMutation,
  requestActiveCronJobCancellation,
} from "../../cron/active-jobs.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { registerActiveCronTaskRun } from "../../cron/service/active-run-cancellation.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
} from "../../gateway/server-methods/types.js";
import { recoverPendingDeliveries } from "../../infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import { sendDurableMessageBatch } from "../../plugin-sdk/channel-outbound.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { createEmbeddedMessageInvocationPolicy } from "../scheduled-message-invocation.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createMessageTool } from "./message-tool-execution.js";

const settled = { status: "settled", partialDelivery: false };
function delivered(messageId: string, withSettlement = true) {
  return {
    details: {
      result: { messageId },
      ...(withSettlement ? { messageDelivery: settled } : {}),
    },
  };
}
function actionResult(details: Record<string, unknown> = { ok: true }) {
  return { content: [{ type: "text" as const, text: '{"ok":true}' }], details };
}

it.each([
  ["provider", "send", "direct", "accepted"],
  ["target", "send", "direct", "rejected"],
  ["action", "set-presence", "direct", "accepted"],
  ["unconfirmed-action", "set-presence", "gateway", "rejected"],
  ["retry", "send", "direct", "rejected"],
  ["retry", "send", "gateway", "rejected"],
  ["provider", "send", "gateway", "accepted"],
  ["generic-retry", "reply", "direct", "rejected"],
  ["generic-retry", "reply", "gateway", "rejected"],
  ["poll-retry", "poll", "gateway", "rejected"],
  ["poll-provider", "poll", "gateway", "accepted"],
  ["multipart", "send", "direct", "partial"],
  ["unbound", "send", "gateway", "rejected"],
  ["partial-action", "set-presence", "direct", "partial"],
  ["partial-action", "set-presence", "gateway", "partial"],
  ["config", "send", "gateway", "accepted"],
  ["poll-partial", "poll", "direct", "partial"],
  ["poll-partial", "poll", "gateway", "partial"],
] as const)(
  "settles %s revocation during %s via %s as %s",
  async (revokeAt, action, deliveryMode, outcome) => {
    const accepted = outcome !== "rejected";
    const partial = outcome === "partial";
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
    const registry = captureActivePluginRegistrySnapshot();
    const state = await createOpenClawTestState();
    const source = new AbortController();
    const boundaryEntered = createDeferred();
    const releaseBoundary = createDeferred();
    const pauseAtBoundary = async () => {
      boundaryEntered.resolve();
      await releaseBoundary.promise;
    };
    const jobId = "scheduled-message-lifetime";
    const runId = "scheduled-message-lifetime-run";
    const sessionKey = `agent:main:cron:${jobId}:run:${runId}`;
    const scheduledToolPolicy = { version: 1, mode: "trusted" } as const;
    const identity = { agentId: "main", runId, sessionId: runId };
    const runOptions = { ...identity, sessionKey, scheduledToolPolicy };
    const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
    const releaseCancellation = registerActiveCronTaskRun({
      runId,
      controller: source,
      activeJobMarker: marker,
    });
    let pending: ReturnType<ReturnType<typeof createMessageTool>["execute"]> | undefined;
    let admission: ReturnType<typeof prepareCronRunAdmission> | undefined;
    let gatewayDispatch: ReturnType<typeof vi.fn<GatewayRequestHandler>> | undefined;
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
      setRuntimeConfigSnapshot(config, config);
      let sendCount = 0;
      const mutations: string[] = [];
      const localActionGatewayFields: [unknown, unknown, unknown, unknown][] = [];
      const pollRequests: string[] = [];
      const sendText = vi.fn(async ({ onPlatformSendDispatch }: ChannelOutboundContext) => {
        sendCount++;
        if (
          at("provider", "retry", "generic-retry") ||
          (revokeAt === "multipart" && sendCount === 1)
        ) {
          await pauseAtBoundary();
        }
        if (at("retry", "generic-retry")) {
          await onPlatformSendDispatch?.();
        }
        return { channel: "discord", messageId: `message-${sendCount}` };
      });
      const listTargetsLive = async () => {
        if (revokeAt === "target") {
          await pauseAtBoundary();
        }
        return [{ kind: "group" as const, id: "channel:100000000000000001", name: "alerts" }];
      };
      const sendPoll = vi.fn(async ({ assertDirectAdapterHandoff }: ChannelPollContext) => {
        pollRequests.push("initial");
        if (at("poll-provider", "poll-retry", "poll-partial")) {
          await pauseAtBoundary();
        }
        if (at("poll-retry", "poll-partial")) {
          try {
            assertDirectAdapterHandoff?.();
          } catch (error) {
            if (revokeAt === "poll-partial") {
              throw createChannelPartialDeliveryError(error, {
                messageIds: ["poll-partial"],
                visibleReplySent: true,
              });
            }
            throw error;
          }
          pollRequests.push("retry");
        }
        return { channel: "discord", messageId: "poll-1" };
      });
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({
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
          supportsAction: ({ action: requestedAction }) =>
            requestedAction === "reply" || requestedAction === "set-presence",
          resolveExecutionMode: () => (viaGateway ? "gateway" : "local"),
          handleAction: async ({
            action: requestedAction,
            params: actionParams,
            gateway: actionGateway,
            cfg: actionConfig,
            deliveryRetryOwner,
            onPlatformSendDispatch,
            assertDirectAdapterHandoff,
            skipQueue,
          }) => {
            if (requestedAction === "reply") {
              const result = await sendDurableMessageBatch({
                cfg: actionConfig,
                channel: "discord",
                to: "channel:100000000000000001",
                payloads: [{ text: "generic" }],
                durability: "required",
                deliveryRetryOwner,
                onPlatformSendDispatch,
                assertDirectAdapterHandoff,
                skipQueue,
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
              localActionGatewayFields.push([
                actionParams.gatewayUrl,
                actionParams.gatewayToken,
                actionGateway?.url,
                actionGateway?.token,
              ]);
            }
            mutations.push(requestedAction);
            if (at("action", "unconfirmed-action", "partial-action")) {
              await pauseAtBoundary();
            }
            if (revokeAt === "partial-action") {
              try {
                await onPlatformSendDispatch?.();
              } catch (error) {
                throw createChannelPartialDeliveryError(error, {
                  messageIds: ["message-action"],
                  visibleReplySent: true,
                });
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
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
      );

      let gatewayContext: GatewayRequestContext | undefined;
      if (viaGateway && revokeAt !== "unbound") {
        const { sendHandlers } = await import("../../gateway/server-methods/send.js");
        const method = "message.action";
        gatewayDispatch = vi.fn(sendHandlers[method] as GatewayRequestHandler);
        const methods = createGatewayMethodRegistry([
          {
            name: method,
            owner: { kind: "core", area: "message" },
            scope: "operator.write",
            handler: gatewayDispatch,
          },
        ]);
        gatewayContext = {
          getRuntimeConfig: () => currentConfig,
          getGatewayMethodRegistry: () => methods,
          validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
          trackExecution: <T>(run: () => Promise<T>) => run(),
          dedupe: new Map(),
        } as GatewayRequestContext;
      }
      const prepareAdmission = () =>
        prepareCronRunAdmission({
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
      bindCronJobAdmittedRun(marker, admitted, source.signal);
      const gatewayCaller = gatewayContext
        ? createAdmittedGatewayToolCallerIdentity({
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
      const tool = createMessageTool({
        config,
        ...identity,
        agentSessionKey: sessionKey,
        agentAccountId: "default",
        messageActionTurnCapability: admission.messageActionTurnCapability,
        admitScheduledInvocation: invocationPolicy.admit,
        resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => {
          if (revokeAt === "config") {
            await pauseAtBoundary();
          }
          return {
            resolvedConfig,
            diagnostics: [],
            targetStatesByPath: {},
            hadUnresolvedTargets: false,
          };
        },
      });
      catalog.push(tool);
      const invoke = <T>(run: () => Promise<T>) =>
        gatewayCaller ? withGatewayToolCallerIdentity(gatewayCaller, run) : run();
      const sameHostConnection = {
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "redundant-same-host-token",
      };
      const defaultConnection =
        revokeAt === "action"
          ? {
              gatewayUrl: "wss://legacy.example.invalid/discarded-path",
              gatewayToken: "legacy-provider-local-token",
            }
          : revokeAt === "provider" && deliveryMode === "direct"
            ? sameHostConnection
            : undefined;
      const execute = (callId: string, gatewayConnection = defaultConnection) =>
        invoke(() =>
          tool.execute(
            callId,
            {
              action,
              channel: "discord",
              ...(action === "set-presence"
                ? {}
                : {
                    target: revokeAt === "target" ? "alerts" : "channel:100000000000000001",
                  }),
              ...(action === "poll"
                ? { pollQuestion: "Ship?", pollOption: ["Yes", "No"] }
                : action === "set-presence"
                  ? {}
                  : {
                      message:
                        action === "reply"
                          ? "generic"
                          : revokeAt === "multipart"
                            ? "first second"
                            : "first",
                    }),
              ...(revokeAt === "config" ? { accountId: "admitted" } : {}),
              ...gatewayConnection,
            },
            source.signal,
          ),
        );

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
        setRuntimeConfigSnapshot(currentConfig, currentConfig);
        releaseBoundary.resolve();
        await expect(pending).resolves.toMatchObject(delivered("message-1"));
        expect(sendText.mock.calls.map(([{ cfg, accountId }]) => ({ cfg, accountId }))).toEqual([
          { cfg: config, accountId: "admitted" },
        ]);
        return;
      }
      if (revokeAt === "action") {
        requestActiveCronJobCancellation(jobId, "Cron job removed by operator.");
      } else {
        noteActiveCronJobMessageActionAuthorityMutation(jobId);
      }
      releaseBoundary.resolve();

      if (accepted) {
        await expect(pending).resolves.toMatchObject(
          partial
            ? {
                details: {
                  ok: false,
                  deliveryStatus: "partial_failed",
                  sentBeforeError: true,
                  result: {
                    messageIds: [
                      revokeAt === "multipart"
                        ? "message-1"
                        : revokeAt === "partial-action"
                          ? "message-action"
                          : "poll-partial",
                    ],
                  },
                },
              }
            : action === "send"
              ? delivered("message-1", viaGateway)
              : action === "poll"
                ? delivered("poll-1")
                : { details: { ok: true } },
        );
      } else {
        await expect(pending).rejects.toThrow(
          viaGateway && revokeAt !== "unconfirmed-action"
            ? "agent runtime authority is no longer active"
            : revokedError,
        );
      }
      await expect(execute("after-revocation")).rejects.toThrow(laterError);
      const sendAttempts =
        (action === "send" && revokeAt !== "target") || revokeAt === "generic-retry" ? 1 : 0;
      expect(sendText).toHaveBeenCalledTimes(sendAttempts);
      expect(
        sendText.mock.calls.map(([{ text, deliveryQueueId }]) => ({ text, deliveryQueueId })),
      ).toEqual(
        Array.from({ length: sendAttempts }, () => ({
          text: revokeAt === "generic-retry" ? "generic" : "first",
          deliveryQueueId: undefined,
        })),
      );
      expect({ mutations, localActionGatewayFields, pollRequests }).toEqual({
        mutations:
          action === "set-presence" && (accepted || revokeAt === "unconfirmed-action")
            ? [action]
            : [],
        localActionGatewayFields:
          revokeAt === "action" ? [[undefined, undefined, undefined, undefined]] : [],
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
      admission?.close();
      releaseCancellation?.();
      clearCronJobActive(jobId, marker);
      restoreActivePluginRegistrySnapshot(registry);
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  },
);

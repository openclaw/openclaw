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
import { prepareCronPromptRunAdmission } from "../../cron/isolated-agent/run-admission.js";
import { registerActiveCronTaskRun } from "../../cron/service/active-run-cancellation.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-identity-token.js";
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

type ScheduledLifetimeCase = {
  cause: string;
  revokeAt:
    | "provider"
    | "target"
    | "action"
    | "unconfirmed-action"
    | "retry"
    | "poll-retry"
    | "generic-retry"
    | "poll-provider"
    | "multipart"
    | "unbound"
    | "partial-action"
    | "config"
    | "poll-partial";
  action: "send" | "poll" | "reply" | "set-presence";
  retire: (jobId: string) => void;
  accepted: boolean;
  partial?: boolean;
  laterError?: string | undefined;
  deliveryMode: "direct" | "gateway";
};

function scheduledLifetimeCase(
  input: Pick<ScheduledLifetimeCase, "cause" | "revokeAt" | "accepted"> &
    Partial<Omit<ScheduledLifetimeCase, "cause" | "revokeAt" | "accepted">>,
): ScheduledLifetimeCase {
  return {
    action: "send",
    retire: noteActiveCronJobMessageActionAuthorityMutation,
    laterError: "cron message action authority is no longer active",
    deliveryMode: "direct",
    ...input,
  };
}

it.each<ScheduledLifetimeCase>([
  scheduledLifetimeCase({
    cause: "message authority is durably revoked",
    revokeAt: "provider" as const,
    accepted: true,
  }),
  scheduledLifetimeCase({
    cause: "the active job is cancelled",
    revokeAt: "provider" as const,
    retire: (jobId: string) =>
      requestActiveCronJobCancellation(jobId, "Cron job removed by operator."),
    accepted: true,
    laterError: "Message send aborted",
  }),
  scheduledLifetimeCase({
    cause: "message authority closes during provider target lookup",
    revokeAt: "target" as const,
    accepted: false,
  }),
  scheduledLifetimeCase({
    cause: "the active job is cancelled after a generic mutation is accepted",
    revokeAt: "action" as const,
    action: "set-presence" as const,
    retire: (jobId: string) =>
      requestActiveCronJobCancellation(jobId, "Cron job removed by operator."),
    accepted: true,
    laterError: "Message send aborted",
  }),
  ...(["direct", "gateway"] as const).map((deliveryMode) =>
    scheduledLifetimeCase({
      cause: `message authority closes during a ${deliveryMode} unconfirmed mutation result`,
      revokeAt: "unconfirmed-action" as const,
      action: "set-presence" as const,
      accepted: false,
      deliveryMode,
    }),
  ),
  scheduledLifetimeCase({
    cause: "message authority closes before a refused write retry",
    revokeAt: "retry" as const,
    accepted: false,
  }),
  scheduledLifetimeCase({
    cause: "message authority closes before a poll provider retry",
    revokeAt: "poll-retry" as const,
    action: "poll" as const,
    accepted: false,
  }),
  scheduledLifetimeCase({
    cause: "message authority closes before a bound Gateway write retry",
    revokeAt: "retry" as const,
    accepted: false,
    deliveryMode: "gateway" as const,
  }),
  scheduledLifetimeCase({
    cause: "same-host Gateway fields are removed from an existing job",
    revokeAt: "provider" as const,
    accepted: true,
    deliveryMode: "gateway" as const,
  }),
  ...(["direct", "gateway"] as const).map((deliveryMode) =>
    scheduledLifetimeCase({
      cause: `message authority closes before a ${deliveryMode} generic durable retry`,
      revokeAt: "generic-retry" as const,
      action: "reply" as const,
      accepted: false,
      deliveryMode,
    }),
  ),
  scheduledLifetimeCase({
    cause: "message authority closes before a bound Gateway poll retry",
    revokeAt: "poll-retry" as const,
    action: "poll" as const,
    accepted: false,
    deliveryMode: "gateway" as const,
  }),
  scheduledLifetimeCase({
    cause: "message authority closes after a bound Gateway poll is accepted",
    revokeAt: "poll-provider" as const,
    action: "poll" as const,
    accepted: true,
    laterError: undefined,
    deliveryMode: "gateway" as const,
  }),
  scheduledLifetimeCase({
    cause: "message authority closes after the first multipart send",
    revokeAt: "multipart" as const,
    accepted: true,
    partial: true,
  }),
  scheduledLifetimeCase({
    cause: "a configured remote Gateway has no active bound host",
    revokeAt: "unbound" as const,
    accepted: false,
    deliveryMode: "gateway" as const,
  }),
  ...(["direct", "gateway"] as const).map((deliveryMode) =>
    scheduledLifetimeCase({
      cause: `message authority closes after a ${deliveryMode} plugin partial mutation`,
      revokeAt: "partial-action" as const,
      action: "set-presence" as const,
      accepted: true,
      partial: true,
      deliveryMode,
    }),
  ),
  scheduledLifetimeCase({
    cause: "a bound Gateway publishes replacement account config during preparation",
    revokeAt: "config" as const,
    accepted: true,
    deliveryMode: "gateway" as const,
  }),
  ...(["direct", "gateway"] as const).map((deliveryMode) =>
    scheduledLifetimeCase({
      cause: `message authority closes after a ${deliveryMode} partial poll`,
      revokeAt: "poll-partial" as const,
      action: "poll" as const,
      accepted: true,
      partial: true,
      deliveryMode,
    }),
  ),
])(
  "owns scheduled message lifetime when $cause",
  async ({ cause, revokeAt, action, retire, accepted, partial, laterError, deliveryMode }) => {
    const registry = captureActivePluginRegistrySnapshot();
    const state = await createOpenClawTestState();
    const source = new AbortController();
    const boundaryEntered = createDeferred();
    const releaseBoundary = createDeferred();
    const jobId = "scheduled-message-lifetime";
    const runId = "scheduled-message-lifetime-run";
    const sessionKey = `agent:main:cron:${jobId}:run:${runId}`;
    const scheduledToolPolicy = { version: 1, mode: "trusted" } as const;
    const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
    const releaseCancellation = registerActiveCronTaskRun({
      runId,
      controller: source,
      activeJobMarker: marker,
    });
    let pending: ReturnType<ReturnType<typeof createMessageTool>["execute"]> | undefined;
    let admission: ReturnType<typeof prepareCronPromptRunAdmission> | undefined;
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
      const sends: string[] = [];
      const queueIds: Array<string | undefined> = [];
      const mutations: string[] = [];
      const localActionGatewayFields: Array<Record<string, unknown>> = [];
      const pollRequests: string[] = [];
      const providerConfigs: OpenClawConfig[] = [];
      const providerAccounts: Array<string | undefined> = [];
      const sendText = vi.fn(
        async ({
          cfg,
          accountId,
          text,
          deliveryQueueId,
          onPlatformSendDispatch,
        }: ChannelOutboundContext) => {
          providerConfigs.push(cfg);
          providerAccounts.push(accountId ?? undefined);
          sends.push(text);
          queueIds.push(deliveryQueueId);
          if (revokeAt === "provider") {
            boundaryEntered.resolve();
            await releaseBoundary.promise;
          }
          if (revokeAt === "multipart" && sends.length === 1) {
            boundaryEntered.resolve();
            await releaseBoundary.promise;
          }
          if (revokeAt === "retry" || revokeAt === "generic-retry") {
            boundaryEntered.resolve();
            await releaseBoundary.promise;
            await onPlatformSendDispatch?.();
          }
          return { channel: "discord", messageId: `message-${sends.length}` };
        },
      );
      const listTargetsLive = async () => {
        if (revokeAt === "target") {
          boundaryEntered.resolve();
          await releaseBoundary.promise;
        }
        return [{ kind: "group" as const, id: "channel:100000000000000001", name: "alerts" }];
      };
      const sendPoll = vi.fn(async ({ assertDirectAdapterHandoff }: ChannelPollContext) => {
        pollRequests.push("initial");
        if (revokeAt === "poll-provider") {
          boundaryEntered.resolve();
          await releaseBoundary.promise;
        }
        if (revokeAt === "poll-retry" || revokeAt === "poll-partial") {
          boundaryEntered.resolve();
          await releaseBoundary.promise;
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
          ...(revokeAt === "config"
            ? {
                config: {
                  listAccountIds: (candidate) =>
                    Object.keys(candidate.channels?.discord?.accounts ?? {}),
                  defaultAccountId: () => "admitted",
                  resolveAccount: (candidate, accountId) =>
                    candidate.channels?.discord?.accounts?.[accountId ?? "admitted"] ?? {},
                },
              }
            : {}),
        }),
        actions: {
          describeMessageTool: () => ({ actions: ["send", "poll", "reply", "set-presence"] }),
          prepareSendPayload: ({ payload }) => payload,
          supportsAction: ({ action: requestedAction }) =>
            requestedAction === "reply" || requestedAction === "set-presence",
          resolveExecutionMode: () => (deliveryMode === "gateway" ? "gateway" : "local"),
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
              return {
                content: [{ type: "text", text: '{"ok":true}' }],
                details: { ok: true },
              };
            }
            if (requestedAction !== "set-presence") {
              throw new Error(`Unexpected plugin action: ${requestedAction}`);
            }
            if (cause === "the active job is cancelled after a generic mutation is accepted") {
              localActionGatewayFields.push({
                gatewayUrl: actionParams.gatewayUrl,
                gatewayToken: actionParams.gatewayToken,
                resolvedUrl: actionGateway?.url,
                resolvedToken: actionGateway?.token,
              });
            }
            mutations.push(requestedAction);
            if (
              revokeAt === "action" ||
              revokeAt === "unconfirmed-action" ||
              revokeAt === "partial-action"
            ) {
              boundaryEntered.resolve();
              await releaseBoundary.promise;
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
            return {
              content: [{ type: "text", text: '{"ok":true}' }],
              details: revokeAt === "unconfirmed-action" ? { channel: "discord" } : { ok: true },
            };
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
      if (deliveryMode === "gateway" && revokeAt !== "unbound") {
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
        prepareCronPromptRunAdmission({
          cfg: config,
          agentId: "main",
          runId,
          sessionId: runId,
          sessionKey,
          jobId,
          toolsAllow: ["message"],
          scheduledToolPolicy,
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
        capabilityProfile: resolveConversationCapabilityProfile({
          config,
          agentId: "main",
          runId,
          sessionId: runId,
          sessionKey,
          scheduledToolPolicy,
        }),
        runtimeProfileAlsoAllow: ["message"],
        toolSearchControlAllowlist: [],
        scheduledToolPolicy,
        catalog: () => ({ tools: catalog }),
        isAvailable: () => catalog.some((tool) => tool.name === "message"),
      });
      const tool = createMessageTool({
        config,
        agentId: "main",
        runId,
        sessionId: runId,
        agentSessionKey: sessionKey,
        agentAccountId: "default",
        messageActionTurnCapability: admission.messageActionTurnCapability,
        admitScheduledInvocation: invocationPolicy.admit,
        resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => {
          if (revokeAt === "config") {
            boundaryEntered.resolve();
            await releaseBoundary.promise;
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
      const send = (
        callId: string,
        message: string,
        gatewayConnection?: { gatewayUrl?: string; gatewayToken?: string },
      ) =>
        invoke(() =>
          tool.execute(
            callId,
            {
              action: "send",
              channel: "discord",
              ...(revokeAt === "config" ? { accountId: "admitted" } : {}),
              target: revokeAt === "target" ? "alerts" : "channel:100000000000000001",
              message: revokeAt === "multipart" ? "first second" : message,
              ...gatewayConnection,
            },
            source.signal,
          ),
        );
      const execute = (callId: string) =>
        action === "send"
          ? send(
              callId,
              "first",
              cause === "message authority is durably revoked" && deliveryMode === "direct"
                ? {
                    gatewayUrl: "ws://127.0.0.1:18789",
                    gatewayToken: "redundant-same-host-token",
                  }
                : undefined,
            )
          : invoke(() =>
              tool.execute(
                callId,
                {
                  action,
                  channel: "discord",
                  ...(action === "poll"
                    ? {
                        target: "channel:100000000000000001",
                        pollQuestion: "Ship?",
                        pollOption: ["Yes", "No"],
                      }
                    : action === "reply"
                      ? {
                          target: "channel:100000000000000001",
                          message: "generic",
                        }
                      : {}),
                  ...(cause === "the active job is cancelled after a generic mutation is accepted"
                    ? {
                        gatewayUrl: "wss://legacy.example.invalid/discarded-path",
                        gatewayToken: "legacy-provider-local-token",
                      }
                    : {}),
                },
                source.signal,
              ),
            );

      if (cause === "same-host Gateway fields are removed from an existing job") {
        await expect(
          send("existing-job-message", "first", {
            gatewayUrl: "ws://127.0.0.1:18789",
            gatewayToken: "redundant-same-host-token",
          }),
        ).rejects.toThrow(
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

      pending = execute(
        cause === "same-host Gateway fields are removed from an existing job"
          ? "existing-job-message"
          : "accepted-before-revocation",
      );
      void pending.catch(() => undefined);
      await withTestTimeout(
        Promise.race([
          boundaryEntered.promise,
          pending.then(
            () => {
              throw new Error("Scheduled message action completed before its provider boundary");
            },
            (error: unknown) => {
              throw error;
            },
          ),
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
        await expect(pending).resolves.toMatchObject({
          details: {
            result: { messageId: "message-1" },
            messageDelivery: { status: "settled", partialDelivery: false },
          },
        });
        expect(providerConfigs).toEqual([config]);
        expect(providerAccounts).toEqual(["admitted"]);
        return;
      }
      retire(jobId);
      releaseBoundary.resolve();

      if (accepted) {
        await expect(pending).resolves.toMatchObject(
          partial
            ? {
                details: {
                  ok: false,
                  deliveryStatus: "partial_failed",
                  sentBeforeError: true,
                  result:
                    revokeAt === "multipart"
                      ? { messageIds: ["message-1"] }
                      : {
                          messageIds: [
                            revokeAt === "partial-action" ? "message-action" : "poll-partial",
                          ],
                        },
                },
              }
            : action === "send"
              ? {
                  details: {
                    result: { messageId: "message-1" },
                    ...(deliveryMode === "gateway"
                      ? { messageDelivery: { status: "settled", partialDelivery: false } }
                      : {}),
                  },
                }
              : action === "poll"
                ? {
                    details: {
                      result: { messageId: "poll-1" },
                      messageDelivery: { status: "settled", partialDelivery: false },
                    },
                  }
                : { details: { ok: true } },
        );
      } else {
        await expect(pending).rejects.toThrow(
          deliveryMode === "gateway" && revokeAt !== "unconfirmed-action"
            ? "agent runtime authority is no longer active"
            : "cron message action authority is no longer active",
        );
      }
      await expect(execute("after-revocation")).rejects.toThrow(laterError);
      const sendAttempts =
        (action === "send" && revokeAt !== "target") || revokeAt === "generic-retry" ? 1 : 0;
      expect(sendText).toHaveBeenCalledTimes(sendAttempts);
      expect(sends).toEqual(
        Array.from({ length: sendAttempts }, () =>
          revokeAt === "generic-retry" ? "generic" : "first",
        ),
      );
      expect(queueIds).toEqual(Array.from({ length: sendAttempts }, () => undefined));
      expect(mutations).toEqual(
        action === "set-presence" && (accepted || revokeAt === "unconfirmed-action")
          ? [action]
          : [],
      );
      expect(localActionGatewayFields).toEqual(
        cause === "the active job is cancelled after a generic mutation is accepted"
          ? [
              {
                gatewayUrl: undefined,
                gatewayToken: undefined,
                resolvedUrl: undefined,
                resolvedToken: undefined,
              },
            ]
          : [],
      );
      expect(pollRequests).toEqual(action === "poll" ? ["initial"] : []);
      if (revokeAt === "retry" || revokeAt === "generic-retry" || revokeAt === "multipart") {
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

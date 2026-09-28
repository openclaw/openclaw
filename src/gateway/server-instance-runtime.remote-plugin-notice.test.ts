import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";

describe("Gateway-owned remote plugin approval requester notice", () => {
  it("reports through the live local source account and leaves remote-only accounts to their owner", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "remote-plugin-approval-notice-" },
      async () => {
        const configForToken = (botToken: string): OpenClawConfig => ({
          channels: {
            slack: { accounts: { work: { botToken } } },
            telegram: { accounts: { work: { botToken: "telegram-test-token" } } },
          },
        });
        const sourceConfig = configForToken("xoxb-original");
        let currentConfig = sourceConfig;
        let sourceTaskActive = true;
        const posts: Array<{ text: string; token: unknown }> = [];
        const pendingPosted = createDeferred();
        const deniedPosted = createDeferred();
        const noReporterPendingPosted = createDeferred();
        const noReporterDeniedPosted = createDeferred();
        const staleHandoff = createDeferred();
        const noticeFailed = createDeferred();
        const telegramPendingPosted = createDeferred();
        const telegramDeniedPosted = createDeferred();
        const telegramNoticeFailed = createDeferred();
        const sendText = vi.fn(
          async (options: {
            text: string;
            cfg: OpenClawConfig;
            onPlatformSendDispatch?: () => Promise<void>;
            assertDirectAdapterHandoff?: () => void;
          }) => {
            if (options.text.includes("plugin:stale-source")) {
              currentConfig = configForToken("xoxb-replacement");
              staleHandoff.resolve();
            }
            await options.onPlatformSendDispatch?.();
            options.assertDirectAdapterHandoff?.();
            posts.push({
              text: options.text,
              token: options.cfg.channels?.slack?.accounts?.work?.botToken,
            });
            if (options.text.includes("plugin:slack-no-reporter")) {
              if (options.text.includes("was denied")) {
                noReporterDeniedPosted.resolve();
              } else {
                noReporterPendingPosted.resolve();
              }
            } else if (options.text.includes("was denied")) {
              deniedPosted.resolve();
            } else {
              pendingPosted.resolve();
            }
            return { channel: "slack", messageId: `1712345678.${posts.length}` };
          },
        );
        const telegramPosts: string[] = [];
        const staleTelegramHandoff = createDeferred();
        const telegramSendText = vi.fn(
          async (options: {
            text: string;
            onPlatformSendDispatch?: () => Promise<void>;
            assertDirectAdapterHandoff?: () => void;
          }) => {
            if (options.text.includes("plugin:stale-remote-telegram")) {
              currentConfig = configForToken("xoxb-replacement");
              staleTelegramHandoff.resolve();
            }
            await options.onPlatformSendDispatch?.();
            options.assertDirectAdapterHandoff?.();
            telegramPosts.push(options.text);
            if (options.text.includes("was denied")) {
              telegramDeniedPosted.resolve();
            } else {
              telegramPendingPosted.resolve();
            }
            return { channel: "telegram", messageId: String(telegramPosts.length) };
          },
        );
        const plugin: ChannelPlugin = {
          id: "slack",
          meta: {
            id: "slack",
            label: "Slack",
            selectionLabel: "Slack",
            docsPath: "/channels/slack",
            blurb: "Slack-shaped approval test plugin.",
          },
          capabilities: { chatTypes: ["direct"] },
          config: {
            listAccountIds: () => ["work"],
            resolveAccount: () => ({}),
            isConfigured: () => true,
          },
          outbound: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "" }),
            sendText,
          },
        };
        const telegramPlugin: ChannelPlugin = {
          ...plugin,
          id: "telegram",
          meta: {
            ...plugin.meta,
            id: "telegram",
            label: "Telegram",
            selectionLabel: "Telegram",
            docsPath: "/channels/telegram",
          },
          outbound: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "" }),
            sendText: telegramSendText,
          },
        };
        const registrySnapshot = captureActivePluginRegistrySnapshot();
        stageActivePluginRegistry(
          createTestRegistry([
            { pluginId: "slack", source: "test", plugin },
            { pluginId: "telegram", source: "test", plugin: telegramPlugin },
          ]),
          null,
          "default",
        );
        const errors: string[] = [];
        const context = {
          trackExecution: trackAsyncWork,
          deps: {},
          getRuntimeConfig: () => currentConfig,
          logGateway: { warn: vi.fn(), error: vi.fn() },
          chatAbortControllers: new Map(),
          chatQueuedTurns: new Map(),
          dedupe: new Map(),
        } as unknown as GatewayRequestContext;
        const runtime = createGatewayInstanceRuntime({
          getContext: () => context,
          getMethodRegistry: () => {
            throw new Error("source notice must not use a public Gateway RPC");
          },
          isDispatchAvailable: () => true,
          captureCurrentChannelAccountTask: () => {
            return sourceTaskActive ? () => sourceTaskActive : undefined;
          },
          logError: (message) => {
            errors.push(message);
            if (message.includes("plugin approval origin notice failed")) {
              noticeFailed.resolve();
              if (errors.length === 2) {
                telegramNoticeFailed.resolve();
              }
            }
          },
        });
        const aux = createGatewayAuxHandlers({
          scheduler: createTestGatewayScheduler(),
          log: {},
          getNativeApprovalRouteCoordinator: () => runtime.nativeApprovals.routeCoordinator,
          activateRuntimeSecrets: createTestRuntimeSecretsActivator(),
          sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
            current: undefined,
            required: null,
          }),
          resolveSharedGatewaySessionGenerationForConfig: () => undefined,
          clients: [],
          channelManager: {
            startChannel: async () => new Map(),
            stopChannel: async () => {},
            isManuallyStopped: () => false,
            resolveRuntimeAccountId: (_channel, accountId) => accountId,
          },
          logChannels: { info: () => {} },
        });
        context.pluginApprovalManager = aux.pluginApprovalManager;
        const reporter = runtime.nativeApprovals.routeCoordinator.createReporter({
          handledKinds: new Set(["plugin"]),
          channel: "slack",
          accountId: "work",
          sourceConfig,
          isOriginCurrent: (_request, cfg) =>
            currentConfig.channels?.slack?.accounts?.work?.botToken === "xoxb-original" &&
            (cfg === undefined || cfg === sourceConfig),
          requestGateway: runtime.nativeApprovals.requestRoute,
          shouldHandle: () => false,
          classifyRoute: () => "unbound",
        });
        const publish = async (
          id: string,
          sourceChannel: "slack" | "telegram" = "slack",
        ): Promise<PluginApprovalRequest> => {
          const record = aux.pluginApprovalManager.create(
            {
              title: "Review action",
              description: "Approve an operation",
              approvalSource: {
                channel: sourceChannel,
                senderId: sourceChannel === "telegram" ? "123" : "U123",
              },
              turnSourceChannel: sourceChannel,
              turnSourceTo: sourceChannel === "telegram" ? "123" : "channel:C123",
              turnSourceAccountId: "work",
              ...(sourceChannel === "slack" ? { turnSourceThreadId: "1712345678.123456" } : {}),
            },
            60_000,
            id,
          );
          await aux.pluginApprovalManager.register(record, 60_000);
          const request: PluginApprovalRequest = {
            approvalKind: "plugin",
            id: record.id,
            request: record.request,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          };
          expect(runtime.approvalEvents.publishRequested("plugin", request)).toBe(0);
          return request;
        };

        try {
          sourceTaskActive = false;
          const remoteOnly = await publish("plugin:remote-only-source");
          await runtime.nativeApprovals.routeCoordinator.finishPluginOriginRouting(
            remoteOnly.id,
            false,
          );
          expect(posts).toEqual([]);
          sourceTaskActive = true;
          reporter.start();

          const request = await publish("plugin:remote-source");
          await pendingPosted.promise;
          expect(posts).toEqual([
            {
              text: `Approval ${request.id} required. An approver can review it in the Control UI or terminal UI.`,
              token: "xoxb-original",
            },
          ]);
          expect(posts[0]?.text).not.toMatch(/sent|delivered|DMs/i);
          await aux.pluginApprovalManager.resolve(request.id, "deny");
          runtime.approvalEvents.publishResolved("plugin", {
            id: request.id,
            decision: "deny",
            ts: Date.now(),
            request: request.request,
          });
          await deniedPosted.promise;
          expect(posts[1]).toEqual({
            text: `Approval ${request.id} was denied. The requested action did not run.`,
            token: "xoxb-original",
          });
          expect(errors).toEqual([]);

          const stale = await publish("plugin:stale-source");
          await staleHandoff.promise;
          await noticeFailed.promise;
          expect(
            errors.some((message) => message.includes("plugin approval origin notice failed")),
          ).toBe(true);
          expect(posts).toHaveLength(2);
          expect(await findDeliveryIntentOwner(`approval-route-notice:${stale.id}`)).toBeNull();
          await runtime.nativeApprovals.routeCoordinator
            .publishPluginTerminal({ approvalId: stale.id, status: "denied" })
            .catch(() => undefined);
          expect(posts).toHaveLength(2);

          currentConfig = sourceConfig;
          await reporter.stop();
          const noReporter = await publish("plugin:slack-no-reporter");
          await noReporterPendingPosted.promise;
          expect(posts[2]?.text).toBe(
            `Approval ${noReporter.id} required. An approver can review it in the Control UI or terminal UI.`,
          );
          await aux.pluginApprovalManager.resolve(noReporter.id, "deny");
          runtime.approvalEvents.publishResolved("plugin", {
            id: noReporter.id,
            decision: "deny",
            ts: Date.now(),
            request: noReporter.request,
          });
          await noReporterDeniedPosted.promise;
          expect(posts[3]?.text).toBe(
            `Approval ${noReporter.id} was denied. The requested action did not run.`,
          );

          // Telegram has no isOriginCurrent hook. A remote reviewer can still
          // receive its card while the source Gateway has no native reporter.
          const telegramRequest = await publish("plugin:remote-telegram", "telegram");
          await telegramPendingPosted.promise;
          expect(telegramPosts).toEqual([
            `Approval ${telegramRequest.id} required. An approver can review it in the Control UI or terminal UI.`,
          ]);
          expect(telegramSendText).toHaveBeenCalledWith(
            expect.objectContaining({ cfg: sourceConfig, accountId: "work", to: "123" }),
          );
          await aux.pluginApprovalManager.resolve(telegramRequest.id, "deny");
          runtime.approvalEvents.publishResolved("plugin", {
            id: telegramRequest.id,
            decision: "deny",
            ts: Date.now(),
            request: telegramRequest.request,
          });
          await telegramDeniedPosted.promise;
          expect(telegramPosts).toEqual([
            `Approval ${telegramRequest.id} required. An approver can review it in the Control UI or terminal UI.`,
            `Approval ${telegramRequest.id} was denied. The requested action did not run.`,
          ]);

          const staleTelegram = await publish("plugin:stale-remote-telegram", "telegram");
          await staleTelegramHandoff.promise;
          await telegramNoticeFailed.promise;
          expect(errors).toHaveLength(2);
          expect(telegramPosts).toHaveLength(2);
          expect(
            await findDeliveryIntentOwner(`approval-route-notice:${staleTelegram.id}`),
          ).toBeNull();
        } finally {
          await reporter.stop();
          await aux.stopOperatorInteractions();
          runtime.close();
          restoreActivePluginRegistrySnapshot(registrySnapshot);
        }
      },
    );
  });
});

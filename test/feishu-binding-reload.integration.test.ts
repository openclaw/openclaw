import { afterEach, expect, it, vi } from "vitest";
import { feishuPlugin } from "../extensions/feishu/api.js";
import { readPreparedConversationBindingRouteCurrent } from "../src/auto-reply/reply/session-conversation-binding.js";
import {
  copyConversationBindingRouteFacts,
  resolveConversationBindingSelection,
  withConversationBindingRouteFacts,
} from "../src/channels/conversation-binding-route-facts.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createChannelManager } from "../src/gateway/server-channels.js";
import { restartGatewayChannels } from "../src/gateway/server-reload-channel-restart.js";
import { getSessionBindingService } from "../src/infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../src/logging/subsystem.js";
import { createChannelIngressQueueForTests } from "../src/plugin-sdk/channel-ingress-test-runtime.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/plugin-test-runtime.js";
import { withServer } from "../src/plugin-sdk/test-helpers/http-test-server.js";
import {
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../src/plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../src/process/gateway-work-admission.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../src/test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { createDeferred } from "./helpers/promise.js";

const external = vi.hoisted(() => ({ transport: vi.fn(), runtime: vi.fn() }));
vi.mock("../extensions/feishu/src/monitor.transport.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../extensions/feishu/src/monitor.transport.js")>();
  return { ...actual, monitorWebSocket: external.transport };
});
vi.mock("../extensions/feishu/src/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/feishu/src/runtime.js")>();
  return { ...actual, getFeishuRuntime: external.runtime };
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

it("keeps prepared DM replies usable after Gateway reload hands off a timed-out Feishu monitor", async () => {
  await withOpenClawTestState({ label: "feishu-binding-reload" }, async (state) => {
    const runtime = createPluginRuntimeMock({
      state: {
        openChannelIngressQueue: <T, TMetadata = unknown, TCompletedMetadata = unknown>() =>
          createChannelIngressQueueForTests<T, TMetadata, TCompletedMetadata>({
            channelId: "feishu",
            accountId: "test",
            stateDir: state.stateDir,
          }),
      },
    });
    external.runtime.mockReturnValue(runtime);
    const delivered: Array<{ receive_id: string; content: string }> = [];
    await withServer(
      (request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
          if (path === "/open-apis/im/v1/messages") {
            delivered.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              path === "/open-apis/auth/v3/tenant_access_token/internal"
                ? { code: 0, tenant_access_token: "fixture-token", expire: 7200 }
                : path === "/open-apis/bot/v3/info"
                  ? { code: 0, bot: { open_id: "ou_fixture_bot", app_name: "Reload fixture" } }
                  : { code: 0, data: { message_id: `om_reply_${delivered.length}` } },
            ),
          );
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      },
      async (origin) => {
        let cfg: OpenClawConfig = {
          channels: {
            feishu: {
              enabled: true,
              domain: origin,
              renderMode: "raw",
              accounts: { test: { appId: "cli_fixture_reload", appSecret: "fixture-secret" } },
            },
          },
        };
        const started = [createDeferred(), createDeferred()] as const;
        const release = [createDeferred(), createDeferred()] as const;
        const predecessorAborted = createDeferred();
        const predecessorSettled = createDeferred();
        let generation = 0;
        external.transport.mockImplementation(
          async ({ abortSignal }: { abortSignal: AbortSignal }) => {
            const index = generation++;
            started[index]?.resolve();
            await new Promise<void>((resolve) => {
              if (abortSignal.aborted) {
                resolve();
              } else {
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
              }
            });
            if (index === 0) {
              predecessorAborted.resolve();
            }
            await release[index]?.promise;
          },
        );
        const startAccount = feishuPlugin.gateway?.startAccount;
        if (!startAccount) {
          throw new Error("Feishu Gateway account entry point is missing");
        }
        const plugin = {
          ...feishuPlugin,
          gateway: {
            ...feishuPlugin.gateway,
            startAccount: async (ctx: Parameters<typeof startAccount>[0]) => {
              const first = generation === 0;
              try {
                await startAccount(ctx);
              } finally {
                if (first) {
                  predecessorSettled.resolve();
                }
              }
            },
          },
        };
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "feishu", plugin, source: "test" }]),
        );
        const log = createSubsystemLogger("gateway/feishu-reload-test");
        const warnings = vi.spyOn(log, "warn");
        const owner = createChannelManager({
          scheduler: createTestGatewayScheduler(),
          getRuntimeConfig: () => cfg,
          getPluginRegistry: requireActivePluginChannelRegistry,
          channelRuntime: runtime.channel,
          channelLogs: { feishu: log },
          channelRuntimeEnvs: {},
        });
        try {
          await owner.startChannel("feishu", "test");
          await started[0].promise;
          const conversation = {
            channel: "feishu",
            accountId: "test",
            conversationId: "oc_reload_dm",
          };
          const route = withConversationBindingRouteFacts(
            { sessionKey: "agent:main:feishu:direct:ou_fixture", agentId: "main" },
            resolveConversationBindingSelection(
              await getSessionBindingService().resolveByConversationAsync(conversation),
            ),
            "main",
            conversation,
          );
          const context = { SessionKey: route.sessionKey, AgentId: route.agentId };
          copyConversationBindingRouteFacts(route, context);
          await expect(readPreparedConversationBindingRouteCurrent(context)).resolves.toBeNull();
          const sendText = feishuPlugin.outbound?.sendText;
          if (!sendText) {
            throw new Error("Feishu outbound text entry point is missing");
          }
          await sendText({
            cfg,
            to: "chat:oc_reload_dm",
            accountId: "test",
            text: "Before reload",
          });
          cfg = {
            ...cfg,
            channels: { ...cfg.channels, feishu: { ...cfg.channels?.feishu, renderMode: "auto" } },
          };
          // Only the legacy stop grace uses timers. Keep database startup and teardown
          // on real I/O; advance the grace after the departing transport sees abort.
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          const reloaded = restartGatewayChannels({
            params: {
              startChannel: owner.startChannel,
              stopChannel: owner.stopChannel,
              getPluginRegistry: requireActivePluginChannelRegistry,
              releaseChannelRouteHandoffs: owner.releaseChannelRouteHandoffs,
              logChannels: log,
            },
            nextConfig: cfg,
            channelsToRestart: new Set(["feishu"]),
            restartChannelAccounts: new Map(),
            activePluginChannelsAfterReload: null,
            shouldSkipChannelRestart: false,
            isLifecycleReloadAborted: () => false,
            getChannelAutostartSuppression: () => null,
            channelReloadTargets: () => new Set(["feishu"]),
            scheduleRecoveryRestart: () => {
              throw new Error("unexpected reload recovery");
            },
          });
          await predecessorAborted.promise;
          await vi.advanceTimersByTimeAsync(5_000);
          await reloaded;
          vi.useRealTimers();
          await started[1].promise;
          expect(warnings).toHaveBeenCalledWith(
            expect.stringContaining("channel stop exceeded 5000ms"),
          );
          release[0].resolve();
          await predecessorSettled.promise;
          await expect(readPreparedConversationBindingRouteCurrent(context)).resolves.toBeNull();
          await sendText({
            cfg,
            to: "chat:oc_reload_dm",
            accountId: "test",
            text: "After predecessor cleanup",
          });
          expect(delivered.map(({ receive_id }) => receive_id)).toEqual([
            "oc_reload_dm",
            "oc_reload_dm",
          ]);
          expect(delivered[0]?.content).toContain("Before reload");
          expect(delivered[1]?.content).toContain("After predecessor cleanup");
        } finally {
          vi.useRealTimers();
          release[0].resolve();
          release[1].resolve();
          await owner.stopChannel("feishu", "test");
        }
      },
    );
  });
});

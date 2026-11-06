import { createJiti } from "jiti";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { withServer, withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import mattermostEntry from "../../extensions/mattermost/index.js";
import * as bootstrapRegistry from "../../src/channels/plugins/bootstrap-registry.js";
import { importBundledChannelContractSourceArtifact } from "../../src/channels/plugins/contracts/test-helpers/runtime-artifacts.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "../../src/infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../src/infra/outbound/deliver.js";
import { drainPendingDeliveriesCore } from "../../src/infra/outbound/delivery-queue-recovery.js";
import {
  createRecoveryLog,
  loadPendingDeliveries,
} from "../../src/infra/outbound/delivery-queue.test-helpers.js";
import { runMessageAction } from "../../src/infra/outbound/message-action-runner.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { readRequestText } from "../helpers/gateway-integration-fixtures.js";

// Keep the public artifact in the host graph: retry errors must retain their identity.
const mattermostPublicApi = await importBundledChannelContractSourceArtifact<{
  mattermostPlugin: ReturnType<typeof mattermostEntry.loadChannelPlugin>;
}>("mattermost", "channel-plugin-api.js", {});
const createEntryLoader: typeof createJiti = (...loaderArgs) =>
  new Proxy(createJiti(...loaderArgs), {
    apply(target, thisArg, args) {
      if (typeof args[0] === "string" && /[/\\]channel-plugin-api\.[cm]?[jt]s$/.test(args[0])) {
        return mattermostPublicApi;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
const mattermostPlugin = mattermostEntry.loadChannelPlugin({
  createLoaderForTest: createEntryLoader,
});
const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "mattermost",
  errorMessage: "Mattermost fixture runtime not initialized",
});
const CHANNEL_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

afterEach(() => {
  vi.restoreAllMocks();
  runtimeStore.clearRuntime();
  resetPluginRuntimeStateForTest();
});

it("preserves queued ambiguity when the sender retires during a post redirect", async () => {
  await withStateDirEnv("mattermost-post-redirect-", async ({ stateDir }) => {
    const requests: Array<{ method?: string; path?: string; jsonBody: unknown }> = [];
    const queueId = "mattermost-post-redirect";
    const retirement = new PlatformMessageNotDispatchedError("Mattermost sender retired", {
      cause: new Error("Mattermost operation ended"),
      retryable: false,
    });
    let senderCurrent = true;
    await withServer(
      (request, response) => {
        void readRequestText(request)
          .then((body) => {
            requests.push({
              method: request.method,
              path: request.url,
              jsonBody:
                body && request.headers["content-type"]?.includes("application/json")
                  ? JSON.parse(body)
                  : undefined,
            });
            if (request.url === "/api/v4/posts") {
              senderCurrent = false;
              response.writeHead(307, { location: "/api/v4/redirected-post" });
            } else {
              response.writeHead(404);
            }
            response.end();
          })
          .catch((error: unknown) => {
            if (!response.headersSent) {
              response.writeHead(500);
            }
            response.end(String(error));
          });
      },
      async (baseUrl) => {
        expect(mattermostPlugin).toBe(mattermostPublicApi.mattermostPlugin);
        vi.spyOn(bootstrapRegistry, "getBootstrapChannelPlugin").mockImplementation((id) =>
          id === mattermostPlugin.id ? mattermostPlugin : undefined,
        );
        runtimeStore.setRuntime(createPluginRuntimeMock());
        setActivePluginRegistry(
          createTestRegistry([
            { pluginId: "mattermost", source: "test", plugin: mattermostPlugin },
          ]),
        );
        const cfg: OpenClawConfig = {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "synthetic-mattermost-send-owner",
              baseUrl,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        };
        await expect(
          runMessageAction({
            cfg,
            action: "send",
            params: {
              channel: "mattermost",
              target: `channel:${CHANNEL_ID}`,
              message: "redirect ambiguity proof",
            },
            conversationReadOrigin: "direct-operator",
            requireQueuePersistence: true,
            deliveryIntentId: queueId,
            assertDirectAdapterHandoff: () => {
              if (!senderCurrent) {
                throw retirement;
              }
            },
          }),
        ).rejects.toThrow("Mattermost sender retired");

        const ambiguousEntry = {
          id: queueId,
          recoveryState: "unknown_after_send",
          platformSendStartedAt: expect.any(Number),
        };
        expect(await loadPendingDeliveries(stateDir)).toMatchObject([ambiguousEntry]);
        await closeOpenClawStateDatabaseByPathAsync(
          resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
        );
        expect(await loadPendingDeliveries(stateDir)).toMatchObject([ambiguousEntry]);
        const log = createRecoveryLog();
        await drainPendingDeliveriesCore({
          drainKey: `mattermost:${stateDir}`,
          logLabel: "Mattermost recovery",
          cfg,
          log,
          stateDir,
          deliver: deliverOutboundPayloads,
          selectEntry: (entry) => ({ match: entry.channel === "mattermost", bypassBackoff: true }),
        });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("refusing blind replay"));
        expect(requests.filter((request) => request.method === "POST")).toMatchObject([
          { path: "/api/v4/posts", jsonBody: { message: "redirect ambiguity proof" } },
        ]);
        expect(requests.some((request) => request.path === "/api/v4/redirected-post")).toBe(false);
      },
    );
  });
});

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { createJiti } from "jiti";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { withServer, withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import mattermostEntry from "../../extensions/mattermost/index.js";
import * as bootstrapRegistry from "../../src/channels/plugins/bootstrap-registry.js";
import { importBundledChannelContractSourceArtifact } from "../../src/channels/plugins/contracts/test-helpers/runtime-artifacts.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { getDeliveryQueueEntryStatus } from "../../src/infra/delivery-queue-sqlite.test-support.js";
import { PlatformMessageNotDispatchedError } from "../../src/infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../src/infra/outbound/deliver.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../src/infra/outbound/delivery-queue-media-staging.js";
import { drainPendingDeliveriesCore } from "../../src/infra/outbound/delivery-queue-recovery.js";
import {
  createRecoveryLog,
  loadPendingDeliveries,
} from "../../src/infra/outbound/delivery-queue.test-helpers.js";
import { runMessageAction } from "../../src/infra/outbound/message-action-runner.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { readRequestText, respondJson } from "../helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../helpers/promise.js";

// Keep the declared public artifact in the host's module graph so error classes
// and retry history have the same identity across the adapter boundary.
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
const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOT_ID = "cccccccccccccccccccccccccc";

type CapturedRequest = {
  method: string;
  path: string;
  jsonBody?: unknown;
};

function createMattermostHttpHandler(params: {
  requests: CapturedRequest[];
  directChannelResponse?: () => Promise<{ status: number; body: unknown }>;
  respondToPost?: (response: ServerResponse) => void;
}): RequestListener {
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, body: unknown) => respondJson(response, body, status);
    const rawBody = await readRequestText(request);
    const contentType = request.headers["content-type"] ?? "";
    const requestPath = request.url ?? "";
    const jsonBody =
      rawBody && contentType.includes("application/json") ? JSON.parse(rawBody) : undefined;
    params.requests.push({
      method: request.method ?? "",
      path: requestPath,
      ...(jsonBody !== undefined ? { jsonBody } : {}),
    });

    if (requestPath === "/api/v4/users/me") {
      reply(200, { id: BOT_ID });
      return;
    }
    if (requestPath === "/api/v4/channels/direct") {
      const result = await params.directChannelResponse?.();
      reply(result?.status ?? 201, result?.body ?? { id: CHANNEL_ID });
      return;
    }
    if (requestPath === "/api/v4/posts") {
      if (params.respondToPost) {
        params.respondToPost(response);
        return;
      }
      reply(201, {
        id: "post-1",
        channel_id: CHANNEL_ID,
        message:
          jsonBody && typeof jsonBody === "object" && "message" in jsonBody ? jsonBody.message : "",
      });
      return;
    }
    reply(404, { message: `unexpected request: ${requestPath}` });
  };
  return (request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(String(error));
    });
  };
}

function registerMattermostRuntime() {
  expect(mattermostPlugin).toBe(mattermostPublicApi.mattermostPlugin);
  // Bootstrap must use the same entry-owned instance as delivery and runtime setup.
  vi.spyOn(bootstrapRegistry, "getBootstrapChannelPlugin").mockImplementation((id) =>
    id === mattermostPlugin.id ? mattermostPlugin : undefined,
  );
  runtimeStore.setRuntime(createPluginRuntimeMock());
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "mattermost", source: "test", plugin: mattermostPlugin }]),
  );
}

function createMattermostConfig(baseUrl: string): OpenClawConfig {
  return {
    channels: {
      mattermost: {
        enabled: true,
        botToken: "synthetic-mattermost-send-owner",
        baseUrl,
        network: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  };
}

function recoverDeliveries(cfg: OpenClawConfig, stateDir: string, log = createRecoveryLog()) {
  return drainPendingDeliveriesCore({
    drainKey: `mattermost:${stateDir}`,
    logLabel: "Mattermost recovery",
    cfg,
    log,
    stateDir,
    deliver: deliverOutboundPayloads,
    selectEntry: (entry) => ({ match: entry.channel === "mattermost", bypassBackoff: true }),
  });
}

const reopenState = (stateDir: string) =>
  closeOpenClawStateDatabaseByPathAsync(
    resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
  );

type SendOptions = Parameters<typeof runMessageAction>[0];
function send(
  cfg: OpenClawConfig,
  params: SendOptions["params"],
  options: Omit<SendOptions, "cfg" | "params" | "action" | "conversationReadOrigin">,
) {
  return runMessageAction({
    cfg,
    action: "send",
    params: { channel: "mattermost", target: `channel:${CHANNEL_ID}`, ...params },
    conversationReadOrigin: "direct-operator",
    ...options,
  });
}

const sentResult = {
  kind: "send",
  handledBy: "core",
  sendResult: { deliveryStatus: "sent", result: { messageId: "post-1" } },
};

afterEach(() => {
  vi.restoreAllMocks();
  runtimeStore.clearRuntime();
  resetPluginRuntimeStateForTest();
});

describe("Mattermost canonical message action delivery", () => {
  it.for(["current", "retired"] as const)(
    "settles queued Mattermost delivery after a DM retry with a %s sender",
    async (senderState, { signal }) => {
      await withStateDirEnv("mattermost-dm-handoff-", async ({ stateDir }) => {
        const requests: CapturedRequest[] = [];
        const firstDmRequest = createDeferred();
        const releaseFirstDm = createDeferred();
        const queueId = `mattermost-dm-handoff-${senderState}`;
        const retirement = new Error("Mattermost sender retired");
        retirement.name = "AbortError";
        let dmRequests = 0;
        let senderCurrent = true;
        signal.addEventListener("abort", () => releaseFirstDm.resolve(), { once: true });
        const handler = createMattermostHttpHandler({
          requests,
          directChannelResponse: async () => {
            if (++dmRequests === 1) {
              firstDmRequest.resolve();
              await releaseFirstDm.promise;
              return { status: 503, body: { message: "DM preparation temporarily unavailable" } };
            }
            return { status: 201, body: { id: CHANNEL_ID } };
          },
        });

        await withServer(handler, async (baseUrl) => {
          registerMattermostRuntime();
          const cfg: OpenClawConfig = {
            channels: {
              mattermost: {
                ...createMattermostConfig(baseUrl).channels?.mattermost,
                dmChannelRetry: { maxRetries: 1, initialDelayMs: 10, maxDelayMs: 10 },
              },
            },
          };
          const delivery = send(
            cfg,
            { target: `user:${USER_ID}`, message: "queued DM proof" },
            {
              requireQueuePersistence: true,
              deliveryIntentId: queueId,
              abortSignal: signal,
              assertDirectAdapterHandoff: () => {
                if (!senderCurrent) {
                  throw retirement;
                }
              },
            },
          );
          const outcome = delivery.then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          try {
            await Promise.race([
              firstDmRequest.promise,
              outcome.then((settled) => {
                throw new Error("Mattermost send settled before DM preparation", {
                  cause: "error" in settled ? settled.error : undefined,
                });
              }),
            ]);
            expect(await loadPendingDeliveries(stateDir)).toMatchObject([
              { id: queueId, channel: "mattermost", to: `user:${USER_ID}` },
            ]);
            senderCurrent = senderState === "current";
            releaseFirstDm.resolve();
            const settled = await outcome;
            const queueStatus = () =>
              getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir);
            const statusBeforeReopen = queueStatus();
            await reopenState(stateDir);
            const statusAfterReopen = queueStatus();
            await recoverDeliveries(cfg, stateDir);

            if (senderState === "retired") {
              expect(settled).toMatchObject({
                error: { message: expect.stringContaining("Mattermost sender retired") },
              });
              expect([statusBeforeReopen, statusAfterReopen, queueStatus()]).toEqual([
                "failed",
                "failed",
                "failed",
              ]);
            } else {
              expect(settled).toMatchObject({ result: sentResult });
            }
            expect(await loadPendingDeliveries(stateDir)).toEqual([]);
            expect(dmRequests).toBe(senderState === "current" ? 2 : 1);
            expect(requests.filter((request) => request.path === "/api/v4/posts")).toHaveLength(
              senderState === "current" ? 1 : 0,
            );
          } finally {
            releaseFirstDm.resolve();
            await outcome;
          }
        });
      });
    },
  );

  it("preserves queued ambiguity when the sender retires during a post redirect", async () => {
    await withStateDirEnv("mattermost-post-redirect-", async ({ stateDir }) => {
      const requests: CapturedRequest[] = [];
      const queueId = "mattermost-post-redirect";
      const retirement = new PlatformMessageNotDispatchedError("Mattermost sender retired", {
        cause: new Error("Mattermost operation ended"),
        retryable: false,
      });
      let senderCurrent = true;
      const handler = createMattermostHttpHandler({
        requests,
        respondToPost: (response) => {
          senderCurrent = false;
          response.writeHead(307, { location: "/api/v4/redirected-post" });
          response.end();
        },
      });

      await withServer(handler, async (baseUrl) => {
        registerMattermostRuntime();
        const cfg = createMattermostConfig(baseUrl);
        await expect(
          send(
            cfg,
            { message: "redirect ambiguity proof" },
            {
              requireQueuePersistence: true,
              deliveryIntentId: queueId,
              assertDirectAdapterHandoff: () => {
                if (!senderCurrent) {
                  throw retirement;
                }
              },
            },
          ),
        ).rejects.toThrow("Mattermost sender retired");

        const ambiguousEntry = {
          id: queueId,
          recoveryState: "unknown_after_send",
          platformSendStartedAt: expect.any(Number),
        };
        expect(await loadPendingDeliveries(stateDir)).toMatchObject([ambiguousEntry]);
        await reopenState(stateDir);
        expect(await loadPendingDeliveries(stateDir)).toMatchObject([ambiguousEntry]);

        const recoveryLog = createRecoveryLog();
        await recoverDeliveries(cfg, stateDir, recoveryLog);
        expect(recoveryLog.warn).toHaveBeenCalledWith(
          expect.stringContaining("refusing blind replay"),
        );
        expect(requests.filter((request) => request.method === "POST")).toMatchObject([
          { path: "/api/v4/posts", jsonBody: { message: "redirect ambiguity proof" } },
        ]);
        expect(requests.some((request) => request.path === "/api/v4/redirected-post")).toBe(false);
      });
    });
  });
});

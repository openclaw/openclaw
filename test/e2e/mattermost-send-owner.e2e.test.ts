import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
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
import { getDeliveryQueueEntryStatus } from "../../src/infra/delivery-queue-sqlite.js";
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
  rawBody: string;
  jsonBody?: unknown;
};

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createMattermostHttpHandler(params: {
  requests: CapturedRequest[];
  sequence?: string[];
  directChannelResponse?: () => Promise<{ status: number; body: unknown }>;
  respondToPost?: (response: ServerResponse) => void;
}): RequestListener {
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const rawBody = await readRequestBody(request);
    const contentType = request.headers["content-type"] ?? "";
    const requestPath = request.url ?? "";
    const jsonBody =
      rawBody && contentType.includes("application/json") ? JSON.parse(rawBody) : undefined;
    params.requests.push({
      method: request.method ?? "",
      path: requestPath,
      rawBody,
      ...(jsonBody !== undefined ? { jsonBody } : {}),
    });

    if (requestPath === "/api/v4/files") {
      params.sequence?.push("http:upload");
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ file_infos: [{ id: "file-1" }] }));
      return;
    }
    if (requestPath === "/api/v4/users/me") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: BOT_ID }));
      return;
    }
    if (requestPath === "/api/v4/users/username/alice") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: USER_ID }));
      return;
    }
    if (requestPath === "/api/v4/channels/direct") {
      const result = await params.directChannelResponse?.();
      response.writeHead(result?.status ?? 201, { "content-type": "application/json" });
      response.end(JSON.stringify(result?.body ?? { id: CHANNEL_ID }));
      return;
    }
    if (requestPath === "/api/v4/posts") {
      params.sequence?.push("http:post");
      if (params.respondToPost) {
        params.respondToPost(response);
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "post-1",
          channel_id: CHANNEL_ID,
          message:
            jsonBody && typeof jsonBody === "object" && "message" in jsonBody
              ? jsonBody.message
              : "",
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: `unexpected request: ${requestPath}` }));
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

function registerMattermostRuntime(params: { sequence?: string[]; activityError?: Error }) {
  expect(mattermostPlugin).toBe(mattermostPublicApi.mattermostPlugin);
  // Bootstrap must use the same entry-owned instance as delivery and runtime setup.
  vi.spyOn(bootstrapRegistry, "getBootstrapChannelPlugin").mockImplementation((id) =>
    id === mattermostPlugin.id ? mattermostPlugin : undefined,
  );
  const runtime = createPluginRuntimeMock();
  vi.spyOn(runtime.channel.activity, "record").mockImplementation(() => {
    params.sequence?.push("bookkeeping:activity");
    if (params.activityError) {
      throw params.activityError;
    }
  });
  runtimeStore.setRuntime(runtime);
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
          registerMattermostRuntime({});
          const cfg: OpenClawConfig = {
            channels: {
              mattermost: {
                ...createMattermostConfig(baseUrl).channels?.mattermost,
                dmChannelRetry: { maxRetries: 1, initialDelayMs: 10, maxDelayMs: 10 },
              },
            },
          };
          const delivery = runMessageAction({
            cfg,
            action: "send",
            params: {
              channel: "mattermost",
              target: `user:${USER_ID}`,
              message: "queued DM proof",
            },
            conversationReadOrigin: "direct-operator",
            requireQueuePersistence: true,
            deliveryIntentId: queueId,
            abortSignal: signal,
            assertDirectAdapterHandoff: () => {
              if (!senderCurrent) {
                throw retirement;
              }
            },
          });
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
            const statusBeforeReopen = getDeliveryQueueEntryStatus(
              OUTBOUND_DELIVERY_QUEUE_NAME,
              queueId,
              stateDir,
            );

            await closeOpenClawStateDatabaseByPathAsync(
              resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
            );
            const statusAfterReopen = getDeliveryQueueEntryStatus(
              OUTBOUND_DELIVERY_QUEUE_NAME,
              queueId,
              stateDir,
            );
            await drainPendingDeliveriesCore({
              drainKey: `mattermost:${stateDir}`,
              logLabel: "Mattermost queued handoff recovery",
              cfg,
              log: createRecoveryLog(),
              stateDir,
              deliver: deliverOutboundPayloads,
              selectEntry: (entry) => ({
                match: entry.channel === "mattermost",
                bypassBackoff: true,
              }),
            });

            if (senderState === "retired") {
              expect(settled).toMatchObject({
                error: { message: expect.stringContaining("Mattermost sender retired") },
              });
              expect(statusBeforeReopen).toBe("failed");
              expect(statusAfterReopen).toBe("failed");
              expect(
                getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir),
              ).toBe("failed");
            } else {
              expect(settled).toMatchObject({
                result: {
                  kind: "send",
                  handledBy: "core",
                  sendResult: { deliveryStatus: "sent", result: { messageId: "post-1" } },
                },
              });
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
        registerMattermostRuntime({});
        const cfg = createMattermostConfig(baseUrl);
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

        const recoveryLog = createRecoveryLog();
        await drainPendingDeliveriesCore({
          drainKey: `mattermost:${stateDir}`,
          logLabel: "Mattermost redirect recovery",
          cfg,
          log: recoveryLog,
          stateDir,
          deliver: deliverOutboundPayloads,
          selectEntry: (entry) => ({
            match: entry.channel === "mattermost",
            bypassBackoff: true,
          }),
        });
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

  it.each([
    ["channel", `channel:${CHANNEL_ID}`],
    ["explicit user", `user:${USER_ID}`],
    ["username", "@alice"],
  ])("keeps the original %s target after provider resolution", async (_name, target) => {
    const requests: CapturedRequest[] = [];

    await withServer(createMattermostHttpHandler({ requests }), async (baseUrl) => {
      registerMattermostRuntime({});
      const result = await runMessageAction({
        cfg: createMattermostConfig(baseUrl),
        action: "send",
        params: {
          channel: "mattermost",
          target,
          message: "target proof",
        },
        conversationReadOrigin: "direct-operator",
        skipQueue: true,
      });

      expect(result).toMatchObject({
        kind: "send",
        handledBy: "core",
        to: target,
        sendResult: {
          deliveryStatus: "sent",
          result: { messageId: "post-1" },
        },
      });
    });

    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/v4/posts",
      jsonBody: { channel_id: CHANNEL_ID, message: "target proof" },
    });
  });

  it("uses the generic replyTo parameter when no thread is provided", async () => {
    const requests: CapturedRequest[] = [];

    await withServer(createMattermostHttpHandler({ requests }), async (baseUrl) => {
      registerMattermostRuntime({});
      const result = await runMessageAction({
        cfg: createMattermostConfig(baseUrl),
        action: "send",
        params: {
          channel: "mattermost",
          target: `channel:${CHANNEL_ID}`,
          message: "reply proof",
          replyTo: "reply-root",
        },
        conversationReadOrigin: "direct-operator",
        skipQueue: true,
      });

      expect(result).toMatchObject({
        kind: "send",
        handledBy: "core",
        sendResult: { deliveryStatus: "sent", result: { messageId: "post-1" } },
      });
    });

    expect(requests.at(-1)?.jsonBody).toMatchObject({
      channel_id: CHANNEL_ID,
      message: "reply proof",
      root_id: "reply-root",
    });
  });

  it("preserves media, presentation, thread, receipt, and progress ordering", async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mattermost-send-")));
    const file = path.join(directory, "report.txt");
    const requests: CapturedRequest[] = [];
    const sequence: string[] = [];
    const onDeliveryResult = vi.fn((result: { messageId?: string }) => {
      sequence.push(`progress:${result.messageId}`);
    });
    await writeFile(file, "report bytes");

    try {
      await withServer(createMattermostHttpHandler({ requests, sequence }), async (baseUrl) => {
        registerMattermostRuntime({ sequence });
        const result = await runMessageAction({
          cfg: createMattermostConfig(baseUrl),
          action: "send",
          params: {
            channel: "mattermost",
            target: `channel:${CHANNEL_ID}`,
            message: "Deploy finished",
            filePath: file,
            attachmentText: "Attachment context",
            threadId: "thread-root",
            replyTo: "child-post",
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [
                    { label: "Open", value: "open", style: "primary" },
                    { label: "Docs", url: "https://example.test/docs" },
                  ],
                },
              ],
            },
          },
          mediaAccess: {
            localRoots: [directory],
            readFile,
            workspaceDir: directory,
          },
          conversationReadOrigin: "direct-operator",
          onDeliveryResult,
          skipQueue: true,
        });

        expect(result).toMatchObject({
          kind: "send",
          handledBy: "core",
          to: `channel:${CHANNEL_ID}`,
          sendResult: {
            deliveryStatus: "sent",
            result: { messageId: "post-1" },
          },
        });
      });

      const upload = requests.find((request) => request.path === "/api/v4/files");
      expect(upload?.rawBody).toContain('filename="report.txt"');
      expect(upload?.rawBody).toContain("Content-Type: text/plain");
      expect(upload?.rawBody).toContain("report bytes");
      const post = requests.find((request) => request.path === "/api/v4/posts");
      expect(post?.jsonBody).toMatchObject({
        channel_id: CHANNEL_ID,
        message: "Deploy finished\n\n- Open\n- Docs: https://example.test/docs",
        root_id: "thread-root",
        file_ids: ["file-1"],
      });
      expect(JSON.stringify(post?.jsonBody)).toContain("Attachment context");
      expect(JSON.stringify(post?.jsonBody)).toContain('"name":"Open"');
      expect(onDeliveryResult).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "mattermost",
          messageId: "post-1",
          receipt: expect.objectContaining({ parts: expect.any(Array) }),
        }),
      );
      expect(sequence).toEqual([
        "http:upload",
        "http:post",
        "progress:post-1",
        "bookkeeping:activity",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns partial delivery evidence when bookkeeping fails after the post", async () => {
    const requests: CapturedRequest[] = [];
    const sequence: string[] = [];
    const onDeliveryResult = vi.fn((result: { messageId?: string }) => {
      sequence.push(`progress:${result.messageId}`);
    });

    await withServer(createMattermostHttpHandler({ requests, sequence }), async (baseUrl) => {
      registerMattermostRuntime({
        sequence,
        activityError: new Error("activity store unavailable"),
      });
      await expect(
        runMessageAction({
          cfg: createMattermostConfig(baseUrl),
          action: "send",
          params: {
            channel: "mattermost",
            target: `channel:${CHANNEL_ID}`,
            message: "partial proof",
          },
          conversationReadOrigin: "direct-operator",
          onDeliveryResult,
          skipQueue: true,
        }),
      ).rejects.toThrow("activity store unavailable");
    });

    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "mattermost",
        messageId: "post-1",
        receipt: expect.objectContaining({ parts: expect.any(Array) }),
      }),
    );
    expect(requests.filter((request) => request.path === "/api/v4/posts")).toHaveLength(1);
    expect(sequence).toEqual(["http:post", "progress:post-1", "bookkeeping:activity"]);
  });
});

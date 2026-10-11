// E2E: a queued Feishu turn sends through the real Lark SDK without replying to its run id.
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
import feishuEntry from "../../extensions/feishu/index.js";
import { buildThreadingToolContext } from "../../src/auto-reply/reply/agent-runner-utils.js";
import * as bootstrapRegistry from "../../src/channels/plugins/bootstrap-registry.js";
import { importBundledChannelContractSourceArtifact } from "../../src/channels/plugins/contracts/test-helpers/runtime-artifacts.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { runMessageAction } from "../../src/infra/outbound/message-action-runner.js";

// Keep the declared public artifact in the host's module graph so delivery and
// bootstrap resolve the same entry-owned plugin instance.
const feishuPublicApi = await importBundledChannelContractSourceArtifact<{
  feishuPlugin: ReturnType<typeof feishuEntry.loadChannelPlugin>;
}>("feishu", "channel-plugin-api.js", {});
const createEntryLoader: typeof createJiti = (...loaderArgs) =>
  new Proxy(createJiti(...loaderArgs), {
    apply(target, thisArg, args) {
      if (typeof args[0] === "string" && /[/\\]channel-plugin-api\.[cm]?[jt]s$/.test(args[0])) {
        return feishuPublicApi;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
const feishuPlugin = feishuEntry.loadChannelPlugin({ createLoaderForTest: createEntryLoader });
const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "feishu",
  errorMessage: "Feishu fixture runtime not initialized",
});

const CHAT_ID = "oc_queued_anchor_group";
const TARGET = `chat:${CHAT_ID}`;
const SESSION_KEY = `agent:main:feishu:group:${CHAT_ID}`;
const TOPIC_ROOT_ID = "om_topic_root";
const TOPIC_SESSION_KEY = `${SESSION_KEY}:topic:${TOPIC_ROOT_ID}`;
// Queued, cron, and cross-session turns are admitted under an internal run id.
const QUEUED_TRIGGER_ID = "b6a9fb30-6bc6-4a52-8f1e-3c2d7e9a4b10";

type CapturedRequest = {
  method: string;
  path: string;
  body?: Record<string, unknown>;
};

function createFeishuOpenApiHandler(requests: CapturedRequest[]): RequestListener {
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: request.method ?? "",
      path: `${url.pathname}${url.search}`,
      ...(rawBody ? { body: JSON.parse(rawBody) as Record<string, unknown> } : {}),
    });
    const respond = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      respond(200, { code: 0, msg: "ok", tenant_access_token: "t-synthetic", expire: 7200 });
      return;
    }
    const replyTarget = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(url.pathname)?.[1];
    if (replyTarget !== undefined) {
      // The reply API addresses open message ids; Feishu rejects any other id with 400.
      if (replyTarget.startsWith("om_")) {
        respond(200, {
          code: 0,
          msg: "success",
          data: { message_id: "om_synthetic_reply", chat_id: CHAT_ID },
        });
      } else {
        respond(400, {
          code: 99992354,
          msg: "The request you send is not a valid {open_message_id} or not exists",
        });
      }
      return;
    }
    if (url.pathname === "/open-apis/im/v1/messages") {
      respond(200, {
        code: 0,
        msg: "success",
        data: { message_id: "om_synthetic_created", chat_id: CHAT_ID },
      });
      return;
    }
    respond(404, { code: 404, msg: `unexpected request: ${url.pathname}` });
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

function registerFeishuRuntime() {
  expect(feishuPlugin).toBe(feishuPublicApi.feishuPlugin);
  vi.spyOn(bootstrapRegistry, "getBootstrapChannelPlugin").mockImplementation((id) =>
    id === feishuPlugin.id ? feishuPlugin : undefined,
  );
  runtimeStore.setRuntime(createPluginRuntimeMock());
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "feishu", source: "test", plugin: feishuPlugin }]),
  );
}

function createFeishuConfig(baseUrl: string): OpenClawConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_queued_anchor_proof",
        appSecret: "synthetic-feishu-secret",
        // Production config requires an https origin; the custom-origin transport
        // rewrites SDK requests to this loopback origin the same way.
        domain: baseUrl,
      },
    },
  };
}

async function sendFromTurn(
  cfg: OpenClawConfig,
  triggerId: string,
  topic?: { sessionKey: string; rootId: string },
) {
  const sessionKey = topic?.sessionKey ?? SESSION_KEY;
  // Same template fields a queued followup builds before it creates the message tool;
  // Feishu inbound routing records a topic session's root message as its thread.
  const toolContext = buildThreadingToolContext({
    sessionCtx: {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: TARGET,
      To: TARGET,
      ChatType: "group",
      SessionKey: sessionKey,
      MessageSid: triggerId,
      MessageSidFull: triggerId,
      ...(topic ? { MessageThreadId: topic.rootId } : {}),
      ReplyToMode: "all",
    },
    config: cfg,
    hasRepliedRef: { value: false },
  });
  return await runMessageAction({
    cfg,
    action: "send",
    params: { channel: "feishu", target: TARGET, message: "Queued status update" },
    toolContext,
    sessionKey,
    agentId: "main",
  });
}

function messageRequests(requests: CapturedRequest[]) {
  return requests.filter((request) => request.path.startsWith("/open-apis/im/"));
}

afterEach(() => {
  vi.restoreAllMocks();
  runtimeStore.clearRuntime();
  resetPluginRuntimeStateForTest();
});

describe("Feishu message tool reply anchors", () => {
  it("creates a new message for a queued turn instead of replying to its run id", async () => {
    await withStateDirEnv("feishu-queued-anchor-", async () => {
      const requests: CapturedRequest[] = [];
      await withServer(createFeishuOpenApiHandler(requests), async (baseUrl) => {
        registerFeishuRuntime();

        await expect(
          sendFromTurn(createFeishuConfig(baseUrl), QUEUED_TRIGGER_ID),
        ).resolves.toMatchObject({ kind: "send" });

        expect(messageRequests(requests)).toEqual([
          expect.objectContaining({
            method: "POST",
            path: "/open-apis/im/v1/messages?receive_id_type=chat_id",
            body: expect.objectContaining({ receive_id: CHAT_ID }),
          }),
        ]);
      });
    });
  });

  it("keeps a queued topic turn's message in its topic", async () => {
    await withStateDirEnv("feishu-queued-topic-anchor-", async () => {
      const requests: CapturedRequest[] = [];
      await withServer(createFeishuOpenApiHandler(requests), async (baseUrl) => {
        registerFeishuRuntime();

        await expect(
          sendFromTurn(createFeishuConfig(baseUrl), QUEUED_TRIGGER_ID, {
            sessionKey: TOPIC_SESSION_KEY,
            rootId: TOPIC_ROOT_ID,
          }),
        ).resolves.toMatchObject({ kind: "send" });

        expect(messageRequests(requests)).toEqual([
          expect.objectContaining({
            method: "POST",
            path: `/open-apis/im/v1/messages/${TOPIC_ROOT_ID}/reply`,
            body: expect.objectContaining({ reply_in_thread: true }),
          }),
        ]);
      });
    });
  });

  it("still replies to the native message that started an inbound turn", async () => {
    await withStateDirEnv("feishu-native-anchor-", async () => {
      const requests: CapturedRequest[] = [];
      await withServer(createFeishuOpenApiHandler(requests), async (baseUrl) => {
        registerFeishuRuntime();

        await expect(
          sendFromTurn(createFeishuConfig(baseUrl), "om_inbound_trigger"),
        ).resolves.toMatchObject({ kind: "send" });

        expect(messageRequests(requests)).toEqual([
          expect.objectContaining({
            method: "POST",
            path: "/open-apis/im/v1/messages/om_inbound_trigger/reply",
          }),
        ]);
      });
    });
  });
});

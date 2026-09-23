import { randomUUID } from "node:crypto";
import { Agent, createServer } from "node:https";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../src/agents/admitted-run-context.js";
import { wrapToolWithGatewayCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelPlugin,
} from "../src/channels/plugins/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../src/config/config.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../src/gateway/agent-runtime-identity-token.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import { createAgentRuntimeAuthorityGuard } from "../src/gateway/server-methods/agent-runtime-authority.js";
import type { GatewayClient, GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../src/infra/agent-run-registry.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import { loadBundledPluginFacade } from "../src/test-utils/bundled-plugin-public-surface.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "./helpers/tls-fixture.js";

const transport = vi.hoisted(() => ({ agent: undefined as Agent | undefined }));
vi.mock("openclaw/plugin-sdk/extension-shared", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/extension-shared")>();
  return { ...actual, resolveAmbientNodeProxyAgent: async () => transport.agent };
});

const CURRENT = "oc_current";
const ALLOWED = "oc_allowed";
const BLOCKED = "oc_blocked";
const DIRECT = "oc_direct";
const SELF = "ou_current_sender";
const MEMBER = "ou_group_member";
const OTHER = "ou_other_member";
const MESSAGE = "om_allowed";
const AUTH_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const MESSAGE_PATH = `/open-apis/im/v1/messages/${MESSAGE}`;
const CHAT_PATH = `/open-apis/im/v1/chats/${ALLOWED}`;
const MEMBERS_PATH = `${CHAT_PATH}/members`;
const PINS_PATH = "/open-apis/im/v1/pins";
const USER_PATH = `/open-apis/contact/v3/users/${MEMBER}`;
const PEERS_PATH = "/open-apis/contact/v3/users";
const PEERS_PAGE_TOKEN = "peers/next+%2F=";
type ActionResult = NonNullable<Awaited<ReturnType<typeof dispatchChannelMessageAction>>>;
type ProviderRequest = { method: string; path: string; query: URLSearchParams };

function createOriginatingRun(currentChat = CURRENT) {
  const sessionKey = `agent:main:feishu:channel:${currentChat}`;
  const operationalRunInstance = createOperationalRunInstanceRef(`feishu-read-${randomUUID()}`);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const toolContext = {
    currentChannelProvider: "feishu",
    currentChannelId: currentChat,
    currentChatType: currentChat === DIRECT ? ("direct" as const) : ("group" as const),
  };
  const turnCapability = mintMessageActionTurnCapability({
    agentId: "main",
    runId: operationalRunInstance.runId,
    sessionKey,
    requesterAccountId: "default",
    requesterSenderId: SELF,
    toolContext,
  });
  const assert = createAgentRuntimeAuthorityGuard(
    {
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey,
          operationalRunInstance,
          delegatedAuthority: { kind: "local", ...delegatedAuthority },
          messageActionContext: { expiresAtMs: Date.now() + 60_000, turnCapability },
        },
      },
    } as GatewayClient,
    {
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    } as GatewayRequestContext,
    () => {},
  ).commitGuard;
  if (!assert) {
    throw new Error("Expected originating Feishu run authority");
  }
  assert();
  return {
    assert,
    toolContext,
    revokeTurn: () => revokeMessageActionTurnCapability(turnCapability),
    releaseClaim: () => releaseAgentRunDelegatedAuthority(delegatedAuthority),
    createTool: (config: OpenClawConfig) =>
      wrapToolWithGatewayCallerIdentity(
        createMessageTool({
          agentId: "main",
          agentAccountId: "default",
          agentSessionKey: sessionKey,
          runId: operationalRunInstance.runId,
          messageActionTurnCapability: turnCapability,
          ...toolContext,
          config,
          getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
          resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
            resolvedConfig,
            diagnostics: [],
            targetStatesByPath: {},
            hadUnresolvedTargets: false,
          }),
        }),
        {
          agentId: "main",
          sessionKey,
          operationalRunInstance,
          receiptAuthority: () => validateAgentRunDelegatedAuthority(delegatedAuthority),
        },
      ),
    dispose: () => {
      revokeMessageActionTurnCapability(turnCapability);
      releaseAgentRunDelegatedAuthority(delegatedAuthority);
    },
  };
}

let feishuPlugin: ChannelPlugin;
let server: ReturnType<typeof createServer>;
let origin: string;
let appId: string;
let requests: ProviderRequest[] = [];
let pending: Promise<unknown>[] = [];
let runs: ReturnType<typeof createOriginatingRun>[] = [];
let beforeReply: ((request: ProviderRequest) => void) | undefined;
let afterProviderResult: ((result: ActionResult) => void) | undefined;

function track<T>(operation: Promise<T>): Promise<T> {
  pending.push(operation);
  return operation;
}

function contentRequests() {
  return requests.filter((request) => request.path !== AUTH_PATH).map((request) => request.path);
}

function expectResult(result: ActionResult | null, details: Record<string, unknown>) {
  expect(result?.details).toMatchObject(details);
  const text = result?.content.find((part) => part.type === "text");
  if (text?.type !== "text") {
    throw new Error("Expected a model-visible Feishu result");
  }
  expect(JSON.parse(text.text)).toMatchObject(details);
}

beforeAll(async () => {
  // TLS trust is fixture-owned; the real SDK can connect only to this loopback host.
  transport.agent = new Agent({ rejectUnauthorized: false });
  const connect = transport.agent.createConnection.bind(transport.agent);
  transport.agent.createConnection = (options, callback) => {
    if (options.host !== "127.0.0.1") {
      throw new Error("Feishu fixture refused a non-loopback destination");
    }
    return connect(options, callback);
  };
  ({ feishuPlugin } = await loadBundledPluginFacade<{ feishuPlugin: ChannelPlugin }>({
    pluginId: "feishu",
    artifactBasename: "api.js",
  }));
  server = createServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM }, (request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const url = new URL(request.url ?? "/", origin);
      const recorded = {
        method: request.method ?? "",
        path: url.pathname,
        query: url.searchParams,
      };
      requests.push(recorded);
      beforeReply?.(recorded);
      response.setHeader("content-type", "application/json");
      if (url.pathname === AUTH_PATH) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (
          request.method !== "POST" ||
          body.app_id !== appId ||
          body.app_secret !== "loopback-placeholder"
        ) {
          response.writeHead(401);
          response.end(JSON.stringify({ code: 99991663, msg: "invalid fixture application" }));
          return;
        }
        response.end(
          JSON.stringify({ code: 0, tenant_access_token: `tat_${appId}`, expire: 7200 }),
        );
        return;
      }
      if (request.method !== "GET" || request.headers.authorization !== `Bearer tat_${appId}`) {
        response.writeHead(401);
        response.end(JSON.stringify({ code: 99991663, msg: "unexpected fixture request" }));
        return;
      }
      let data: unknown;
      if (url.pathname === MESSAGE_PATH) {
        data = {
          items: [
            {
              message_id: MESSAGE,
              chat_id: ALLOWED,
              msg_type: "text",
              body: { content: JSON.stringify({ text: "allowed context" }) },
            },
          ],
        };
      } else if (url.pathname === `${MESSAGE_PATH}/reactions`) {
        data = {
          items: [
            {
              reaction_id: "reaction-1",
              reaction_type: { emoji_type: "THUMBSUP" },
              operator: { operator_type: "user", operator_id: MEMBER },
            },
          ],
          has_more: false,
        };
      } else if (url.pathname === PINS_PATH) {
        data = { items: [{ message_id: MESSAGE, chat_id: ALLOWED }], has_more: false };
      } else if (url.pathname === MEMBERS_PATH) {
        const next = url.searchParams.get("page_token") === "members-next";
        data = {
          items: [{ member_id: next ? MEMBER : OTHER, member_id_type: "open_id" }],
          has_more: !next,
          ...(next ? {} : { page_token: "members-next" }),
        };
      } else if (url.pathname === "/open-apis/im/v1/chats") {
        const next = url.searchParams.get("page_token") === "groups-next";
        data = {
          items: [{ chat_id: next ? ALLOWED : BLOCKED, name: next ? "Allowed" : "Blocked" }],
          has_more: !next,
          ...(next ? {} : { page_token: "groups-next" }),
        };
      } else if (url.pathname.startsWith("/open-apis/im/v1/chats/")) {
        data = {
          name: url.pathname.endsWith(DIRECT) ? "Direct" : "Allowed",
          chat_mode: url.pathname.endsWith(DIRECT) ? "p2p" : "group",
          chat_type: "private",
        };
      } else if (url.pathname === PEERS_PATH) {
        const next = url.searchParams.get("page_token") === PEERS_PAGE_TOKEN;
        data = {
          items: [{ open_id: next ? OTHER : SELF, name: next ? "Other" : "Current sender" }],
          has_more: !next,
          ...(next ? {} : { page_token: PEERS_PAGE_TOKEN }),
        };
      } else if (url.pathname.startsWith("/open-apis/contact/v3/users/")) {
        const id = url.pathname.split("/").at(-1);
        data = { user: { open_id: id, name: id === SELF ? "Current sender" : "Allowed member" } };
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ code: 404, msg: "unhandled fixture route" }));
        return;
      }
      response.end(JSON.stringify({ code: 0, data }));
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback TCP listener");
  }
  origin = `https://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await Promise.allSettled(pending);
  runs.forEach((run) => run.dispose());
  runs = [];
  pending = [];
  requests = [];
  beforeReply = undefined;
  afterProviderResult = undefined;
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  transport.agent?.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  vi.doUnmock("openclaw/plugin-sdk/extension-shared");
  vi.resetModules();
});

function createFixture(
  options: {
    bundled?: boolean;
    trusted?: boolean;
    currentChat?: string;
    actions?: readonly ChannelMessageActionName[];
  } = {},
) {
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  appId = `cli_feishu_${randomUUID()}`;
  const stickerSets: Record<string, Record<string, string[]>> = {
    [appId]: { file_allowed: ["thumbs up"] },
    other_application: { file_other: ["thumbs up"] },
  };
  const settings = {
    enabled: true,
    appId,
    appSecret: "loopback-placeholder", // pragma: allowlist secret
    domain: origin,
    groupPolicy: "allowlist" as "allowlist" | "open",
    groupAllowFrom: [ALLOWED, BLOCKED],
    groups: { [ALLOWED]: { enabled: true }, [BLOCKED]: { enabled: false } },
    allowFrom: [SELF],
    dms: { [OTHER]: {} },
    actions: { reactions: true, sticker: true },
    stickerSets,
  };
  const cfg = { channels: { feishu: settings } } satisfies OpenClawConfig;
  const run = createOriginatingRun(options.currentChat);
  runs.push(run);
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  // Registrar trust is a fixture; the prerequisite owns installer provenance proof.
  const record = createPluginRecord({
    id: "feishu",
    origin: options.bundled ? "bundled" : "global",
    trustedOfficialInstall: !options.bundled && options.trusted !== false,
  });
  const plugin: ChannelPlugin = {
    ...feishuPlugin,
    actions: {
      ...feishuPlugin.actions!,
      readAuthorityActions: options.actions ?? feishuPlugin.actions?.readAuthorityActions,
      handleAction: async (ctx) => {
        const result = await feishuPlugin.actions!.handleAction!(ctx);
        // Revoke at the registered handler's return boundary after a real local consumer.
        afterProviderResult?.(result);
        return result;
      },
    },
  };
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: cfg, registrationMode: "full" }).registerChannel({ plugin });
  setActivePluginRegistry(owner.registry);
  const dispatch = (
    action: ChannelMessageActionName,
    params: Record<string, unknown>,
    overrides: Partial<ChannelMessageActionContext> = {},
  ) =>
    track(
      dispatchChannelMessageAction({
        cfg,
        channel: "feishu",
        action,
        params,
        accountId: "default",
        requesterAccountId: "default",
        requesterSenderId: SELF,
        conversationReadOrigin: "delegated",
        assertDirectAdapterHandoff: run.assert,
        toolContext: run.toolContext,
        ...overrides,
      }),
    );
  return { cfg, settings, record, run, dispatch };
}

const readCases: Array<{
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  details: Record<string, unknown>;
  paths: string[];
}> = [
  {
    action: "read",
    params: { chatId: ALLOWED, messageId: MESSAGE },
    details: { message: { messageId: MESSAGE, chatId: ALLOWED, content: "allowed context" } },
    paths: [MESSAGE_PATH, CHAT_PATH],
  },
  {
    action: "reactions",
    params: { chatId: ALLOWED, messageId: MESSAGE },
    details: {
      reactions: [{ reactionId: "reaction-1", emojiType: "THUMBSUP", operatorId: MEMBER }],
    },
    paths: [MESSAGE_PATH, CHAT_PATH, `${MESSAGE_PATH}/reactions`],
  },
  {
    action: "list-pins",
    params: { chatId: ALLOWED },
    details: { chatId: ALLOWED, pins: [{ messageId: MESSAGE, chatId: ALLOWED }] },
    paths: [CHAT_PATH, PINS_PATH],
  },
  {
    action: "member-info",
    params: { chatId: ALLOWED, memberId: MEMBER },
    details: { member: { member_id: MEMBER, name: "Allowed member" } },
    paths: [CHAT_PATH, MEMBERS_PATH, MEMBERS_PATH, USER_PATH],
  },
  {
    action: "channel-info",
    params: { chatId: ALLOWED },
    details: { channel: { chat_id: ALLOWED, name: "Allowed" } },
    paths: [CHAT_PATH],
  },
  {
    action: "channel-list",
    params: {},
    details: { groups: [{ kind: "group", id: ALLOWED }], peers: [{ kind: "user", id: SELF }] },
    paths: [],
  },
  {
    action: "sticker-search",
    params: { query: "thumbs" },
    details: { stickers: [{ fileId: "file_allowed", keyword: "thumbs up" }], truncated: false },
    paths: [],
  },
];

describe.each([false, true])("Feishu provider read parity (bundled: %s)", (bundled) => {
  it.each(readCases)(
    "runs $action through its real consumer",
    async ({ action, params, details, paths }) => {
      const fixture = createFixture({ bundled });
      expectResult(await fixture.dispatch(action, params), details);
      expect(contentRequests()).toEqual(paths);
      expect(
        requests
          .filter((request) => request.path !== AUTH_PATH)
          .every((request) => request.method === "GET"),
      ).toBe(true);
    },
  );
});

it("filters live directory pages before applying the limit", async () => {
  const fixture = createFixture();
  fixture.settings.groupPolicy = "open";
  fixture.settings.allowFrom = ["*"];
  expectResult(await fixture.dispatch("channel-list", { limit: 1 }), {
    groups: [{ kind: "group", id: ALLOWED, name: "Allowed" }],
    peers: [{ kind: "user", id: SELF, name: "Current sender" }],
  });
  expect(contentRequests().filter((path) => path === "/open-apis/im/v1/chats")).toHaveLength(2);
  expect(contentRequests()).toContain("/open-apis/contact/v3/users");
});

it("finds a live peer on later pages through the registered channel-list action", async () => {
  const fixture = createFixture();
  fixture.settings.allowFrom = ["*"];

  expectResult(
    await fixture.dispatch("channel-list", { scope: "peers", query: "Other", limit: 1 }),
    { peers: [{ kind: "user", id: OTHER, name: "Other" }] },
  );
  const pages = requests.filter((request) => request.path === PEERS_PATH);
  expect(pages).toHaveLength(2);
  expect(pages[0]?.query.get("page_token")).toBeNull();
  expect(pages[1]?.query.get("page_token")).toBe(PEERS_PAGE_TOKEN);
  expect(contentRequests()).toEqual([PEERS_PATH, PEERS_PATH]);
});

it.each(["plugin", "turn", "claim"] as const)(
  "stops live peer pagination when the %s retires between pages",
  async (owner) => {
    const fixture = createFixture();
    fixture.settings.allowFrom = ["*"];
    beforeReply = (request) => {
      if (request.path !== PEERS_PATH) {
        return;
      }
      if (owner === "plugin") {
        fixture.record.enabled = false;
      } else if (owner === "turn") {
        fixture.run.revokeTurn();
      } else {
        fixture.run.releaseClaim();
      }
    };

    await expect(
      fixture.dispatch("channel-list", { scope: "peers", query: "Other", limit: 1 }),
    ).rejects.toThrow("no longer active");
    expect(contentRequests()).toEqual([PEERS_PATH]);
  },
);

it("cancels live peer pagination through the local message tool", async () => {
  const fixture = createFixture();
  fixture.settings.allowFrom = ["*"];
  setRuntimeConfigSnapshot(fixture.cfg, fixture.cfg);
  const tool = fixture.run.createTool(fixture.cfg);
  const controller = new AbortController();
  beforeReply = (request) => {
    if (request.path === PEERS_PATH) {
      controller.abort();
    }
  };

  await expect(
    track(
      tool.execute(
        "feishu-peer-directory",
        { action: "channel-list", channel: "feishu", scope: "peers", query: "Other", limit: 1 },
        controller.signal,
      ),
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(contentRequests()).toEqual([PEERS_PATH]);
});

it.each([SELF, OTHER])(
  "limits a direct-chat profile read to the current sender (%s)",
  async (memberId) => {
    const fixture = createFixture({ currentChat: DIRECT });
    const result = fixture.dispatch("member-info", { chatId: DIRECT, memberId });
    if (memberId === SELF) {
      expectResult(await result, { member: { member_id: SELF, name: "Current sender" } });
      expect(contentRequests()).toEqual([
        `/open-apis/im/v1/chats/${DIRECT}`,
        `/open-apis/contact/v3/users/${SELF}`,
      ]);
    } else {
      await expect(result).rejects.toThrow("limited to the current sender");
      expect(contentRequests()).toEqual([`/open-apis/im/v1/chats/${DIRECT}`]);
    }
  },
);

it.each(["account", "origin", "target", "reactions", "sticker", "catalog"] as const)(
  "retains the %s denial before provider I/O",
  async (kind) => {
    const fixture = createFixture();
    let action: ChannelMessageActionName = "read";
    let params: Record<string, unknown> = { chatId: ALLOWED, messageId: MESSAGE };
    let overrides: Partial<ChannelMessageActionContext> = {};
    let error = "current provider and account";
    if (kind === "account") {
      overrides = { requesterAccountId: "other" };
    }
    if (kind === "origin") {
      overrides = { toolContext: undefined };
    }
    if (kind === "target") {
      params.chatId = BLOCKED;
      error = "not allowed";
    }
    if (kind === "reactions") {
      action = "reactions";
      fixture.settings.actions.reactions = false;
      error = "disabled";
    }
    if (kind === "sticker" || kind === "catalog") {
      action = "sticker-search";
      params = { query: "thumbs" };
      if (kind === "sticker") {
        fixture.settings.actions.sticker = false;
        error = "disabled";
      } else {
        delete fixture.settings.stickerSets[fixture.settings.appId];
        error = "this account's appId";
      }
    }
    await expect(fixture.dispatch(action, params, overrides)).rejects.toThrow(error);
    expect(requests).toEqual([]);
  },
);

it("does not widen an older read list when the host classifies member-info", async () => {
  const fixture = createFixture({ actions: ["read"] });
  expectResult(await fixture.dispatch("read", { chatId: ALLOWED, messageId: MESSAGE }), {
    message: { content: "allowed context" },
  });
  requests = [];
  await expect(
    fixture.dispatch("member-info", { chatId: ALLOWED, memberId: MEMBER }),
  ).rejects.toThrow("exact current conversation");
  expect(requests).toEqual([]);
});

it("does not grant cross-context write authority through an overbroad read declaration", async () => {
  const fixture = createFixture({
    actions: [...feishuPlugin.actions!.readAuthorityActions!, "pin"],
  });
  await expect(fixture.dispatch("pin", { chatId: ALLOWED, messageId: MESSAGE })).rejects.toThrow(
    "exact current conversation",
  );
  expect(requests).toEqual([]);
});

it("retains the exact-current restriction for an unverified external installation", async () => {
  const fixture = createFixture({ trusted: false });
  await expect(fixture.dispatch("read", { chatId: ALLOWED, messageId: MESSAGE })).rejects.toThrow(
    "exact current conversation",
  );
  expect(requests).toEqual([]);
});

describe.each(["plugin", "turn", "claim"] as const)("Feishu %s lifetime", (owner) => {
  it.each(["metadata", "result"] as const)("rejects retirement at %s", async (phase) => {
    const fixture = createFixture();
    beforeReply = (request) => {
      if (request.path !== (phase === "metadata" ? CHAT_PATH : PINS_PATH)) {
        return;
      }
      if (owner === "plugin") {
        fixture.record.enabled = false;
      }
      if (owner === "turn") {
        fixture.run.revokeTurn();
      }
      if (owner === "claim") {
        fixture.run.releaseClaim();
      }
    };
    await expect(fixture.dispatch("list-pins", { chatId: ALLOWED })).rejects.toThrow(
      "no longer active",
    );
    expect(contentRequests()).toEqual(phase === "metadata" ? [CHAT_PATH] : [CHAT_PATH, PINS_PATH]);
  });
});

it.each(["sticker-search", "channel-list", "member-info"] as const)(
  "rejects a retired local %s result",
  async (action) => {
    const fixture = createFixture({ currentChat: action === "member-info" ? DIRECT : CURRENT });
    let observed: ActionResult | undefined;
    afterProviderResult = (result) => {
      observed = result;
      if (action === "sticker-search") {
        fixture.run.releaseClaim();
      }
      if (action === "channel-list") {
        fixture.record.enabled = false;
      }
      if (action === "member-info") {
        fixture.run.revokeTurn();
      }
    };
    const params =
      action === "sticker-search"
        ? { query: "thumbs" }
        : action === "member-info"
          ? { chatId: DIRECT }
          : {};
    await expect(fixture.dispatch(action, params)).rejects.toThrow("no longer active");
    if (action === "sticker-search") {
      expectResult(observed ?? null, { stickers: [{ fileId: "file_allowed" }] });
    }
    if (action === "channel-list") {
      expectResult(observed ?? null, { groups: [{ id: ALLOWED }], peers: [{ id: SELF }] });
    }
    if (action === "member-info") {
      expectResult(observed ?? null, { members: [{ member_id: SELF }] });
    }
    expect(contentRequests()).toEqual(
      action === "member-info" ? [`/open-apis/im/v1/chats/${DIRECT}`] : [],
    );
  },
);

it.each(["allowed", "turn", "claim"] as const)(
  "uses the normal local message tool (%s)",
  async (mode) => {
    const fixture = createFixture();
    setRuntimeConfigSnapshot(fixture.cfg, fixture.cfg);
    const tool = fixture.run.createTool(fixture.cfg);
    beforeReply = (request) => {
      if (request.path !== CHAT_PATH) {
        return;
      }
      if (mode === "turn") {
        fixture.run.revokeTurn();
      }
      if (mode === "claim") {
        fixture.run.releaseClaim();
      }
    };
    const result = track(
      tool.execute("feishu-read", {
        action: "read",
        channel: "feishu",
        target: `chat:${ALLOWED}`,
        messageId: MESSAGE,
      }),
    );
    if (mode === "allowed") {
      expectResult(await result, { message: { messageId: MESSAGE, content: "allowed context" } });
    } else {
      await expect(result).rejects.toThrow("no longer active");
    }
    expect(contentRequests()).toEqual([MESSAGE_PATH, CHAT_PATH]);
  },
);

it("rejects a configured account disabled after local message-tool creation", async () => {
  const fixture = createFixture();
  const cfg = {
    channels: {
      feishu: {
        ...fixture.settings,
        accounts: { default: { enabled: true } },
      },
    },
  } satisfies OpenClawConfig;
  setRuntimeConfigSnapshot(cfg, cfg);
  const tool = fixture.run.createTool(cfg);
  cfg.channels.feishu.accounts.default.enabled = false;
  setRuntimeConfigSnapshot(cfg, cfg);
  expect(feishuPlugin.config.resolveAccount(cfg, "default")).toMatchObject({
    configured: true,
    enabled: false,
  });

  await expect(
    track(
      tool.execute("feishu-disabled-read", {
        action: "read",
        channel: "feishu",
        accountId: "default",
        target: `chat:${ALLOWED}`,
        messageId: MESSAGE,
      }),
    ),
  ).rejects.toThrow('Account "default" for channel feishu is disabled.');
  expect(requests).toEqual([]);
});

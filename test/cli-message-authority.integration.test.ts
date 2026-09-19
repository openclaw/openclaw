import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../extensions/discord/api.js";
import { slackPlugin } from "../extensions/slack/api.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../src/agents/admitted-run-context.js";
import { buildPreparedCliRunContext } from "../src/agents/cli-runner.test-helpers.js";
import { runPlugin, SUCCESS_RESULT } from "../src/agents/cli-runner/execute-plugin.test-support.js";
import { createCliToolTracking } from "../src/agents/cli-runner/execute-tool-tracking.js";
import { buildCliMcpGrantContext } from "../src/agents/cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../src/agents/cli-runner/types.js";
import type { ScheduledToolPolicyContext } from "../src/agents/scheduled-tool-policy.js";
import type { ChannelMessageActionAdapter } from "../src/channels/plugins/types.core.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../src/gateway/agent-runtime-identity-token.js";
import type { CronAuthenticatedChannelRequester } from "../src/gateway/cron-creator-authority-grant.types.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "../src/gateway/mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../src/gateway/mcp-http.js";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  getActiveMcpLoopbackRuntime,
} from "../src/gateway/mcp-http.loopback-runtime.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import { createRequestGatewayMethodRegistry } from "../src/gateway/server-methods.js";
import type { GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../src/plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import { trackAsyncWork } from "../src/shared/async-work-scope.js";
import type { Deferred } from "../src/shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";

// Device inventory is unrelated to the real grant, message tool, and provider boundary.
vi.mock("../src/agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

const channels = {
  discord: { current: "100000000000000003", sender: "100000000000000009" },
  slack: { current: "C0123456789", sender: "U0123456789" },
};
const discordSibling = "100000000000000004";
const discordDm = "100000000000000005";
const discordGuild = "100000000000000001";
const discordManagementRole = "100000000000000006";
const discordMessage = "100000000000000020";
const discordWorkToken = "synthetic-scheduled-work-token";
const discordChannelPath = `/api/v10/channels/${channels.discord.current}`;
const discordMessagePath = `${discordChannelPath}/messages/${discordMessage}`;
const discordPinPath = `${discordChannelPath}/pins/${discordMessage}`;
const discordGuildsPath = "/api/v10/users/@me/guilds";
const discordGuildChannelsPath = `/api/v10/guilds/${discordGuild}/channels`;
const react = { action: "react", channel: "discord", messageId: discordMessage, emoji: "✅" };
const channelEdit = {
  action: "channel-edit",
  channel: "discord",
  target: `channel:${channels.discord.current}`,
  topic: "A permitted channel topic",
};
const trustedScheduledPolicy: ScheduledToolPolicyContext = { version: 1, mode: "trusted" };
const accountScheduledPolicy: ScheduledToolPolicyContext = {
  version: 1,
  mode: "account",
  ownerSessionKey: `agent:main:discord:channel:${channels.discord.current}`,
  ownerAccountId: "default",
  ownerOrigin: { kind: "external", channel: "discord" },
};
const channelRequester: CronAuthenticatedChannelRequester = {
  version: 1,
  channel: "discord",
  accountId: "default",
  senderId: channels.discord.sender,
};
type McpResponse = {
  result?: {
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: unknown;
};

function expectSuccess(response: McpResponse) {
  expect(response.error).toBeUndefined();
  expect(response.result?.isError, JSON.stringify(response)).not.toBe(true);
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  expect(JSON.parse(text ?? "null")).toMatchObject({ ok: true });
}

function expectDenied(response: McpResponse, reason: RegExp) {
  expect(response.error).toBeUndefined();
  expect(response.result?.isError).toBe(true);
  expect(response.result?.content?.map((item) => item.text).join("\n")).toMatch(reason);
}

describe("CLI message authority integration", () => {
  const requests: Array<{
    method: string;
    path: string;
    fields: Record<string, string>;
    body: string;
    usesWorkCredential: boolean;
  }> = [];
  const cleanupTurns: Array<() => void> = [];
  const providerWork = new Set<Promise<void>>();
  const providerErrors: unknown[] = [];
  let provider: Server;
  let providerOrigin: string;
  let mcpOrigin: string;
  let cfg: OpenClawConfig;
  let initialConfig: OpenClawConfig;
  let registeredDiscordActions: ChannelMessageActionAdapter | undefined;
  let workspaceDir: string;
  let sequence = 0;
  let realFetch: typeof fetch;
  let directoryChannelName: string;
  let gatewaySend = false;
  let acceptedChannelEdits = 0;
  let nextChannelEditStatus: 403 | 429 | undefined;
  let acceptedMessageWrites = 0;
  let nextMessageWriteStatus: 403 | undefined;
  let heldRequest:
    | {
        method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        path: string;
        entered: Deferred;
        release: Deferred;
      }
    | undefined;

  async function handleProviderRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString();
    const fields = Object.fromEntries(new URLSearchParams(rawBody));
    requests.push({
      method: req.method ?? "",
      path: url.pathname,
      fields,
      body: rawBody,
      usesWorkCredential: req.headers.authorization === `Bot ${discordWorkToken}`,
    });
    const isChannelEdit = req.method === "PATCH" && url.pathname === discordChannelPath;
    const messageWriteTarget = /^\/api\/v10\/channels\/(\d+)\/(messages|pins)\/(\d+)$/.exec(
      url.pathname,
    );
    const isMessageWrite =
      (messageWriteTarget?.[2] === "messages" &&
        (req.method === "PATCH" || req.method === "DELETE")) ||
      (messageWriteTarget?.[2] === "pins" && (req.method === "PUT" || req.method === "DELETE"));
    const rejectedWriteStatus = isChannelEdit
      ? nextChannelEditStatus
      : isMessageWrite
        ? nextMessageWriteStatus
        : undefined;
    if (isChannelEdit) {
      nextChannelEditStatus = undefined;
    }
    if (isMessageWrite) {
      nextMessageWriteStatus = undefined;
    }
    if (isChannelEdit || isMessageWrite) {
      if (rejectedWriteStatus) {
        res.writeHead(rejectedWriteStatus, {
          "content-type": "application/json",
          ...(rejectedWriteStatus === 429 ? { "retry-after": "0.001" } : {}),
        });
        res.flushHeaders();
      } else if (isChannelEdit) {
        // The fixture accepts the mutation before an optional response barrier.
        acceptedChannelEdits += 1;
      } else {
        acceptedMessageWrites += 1;
      }
    }
    const gate = heldRequest;
    if (gate && req.method === gate.method && url.pathname === gate.path) {
      gate.entered.resolve();
      await gate.release.promise;
      if (heldRequest === gate) {
        heldRequest = undefined;
      }
    }
    if (rejectedWriteStatus) {
      res.end(
        JSON.stringify(
          rejectedWriteStatus === 429
            ? { message: "Rate limited", retry_after: 0.001, global: false }
            : { message: "Missing Permissions", code: 50013 },
        ),
      );
      return;
    }
    let body: unknown;
    if (req.method === "GET" && url.pathname === discordGuildsPath) {
      body = [{ id: discordGuild, name: "Scheduled administration" }];
    } else if (req.method === "GET" && url.pathname === discordGuildChannelsPath) {
      body = [
        {
          id: channels.discord.current,
          type: 0,
          guild_id: discordGuild,
          name: directoryChannelName,
        },
      ];
    } else if (req.method === "GET" && /^\/api\/v10\/channels\/\d+$/.test(url.pathname)) {
      const channelId = url.pathname.split("/").at(-1);
      body =
        channelId === discordDm
          ? { id: discordDm, type: 1, recipients: [{ id: channels.discord.sender }] }
          : { id: channelId, type: 0, guild_id: discordGuild, name: "allowed" };
    } else if (req.method === "GET" && /\/channels\/\d+\/messages$/.test(url.pathname)) {
      body = [];
    } else if (req.method === "POST" && url.pathname === "/api/v10/users/@me/channels") {
      expect(JSON.parse(rawBody)).toEqual({ recipient_id: channels.discord.sender });
      body = { id: discordDm, type: 1, recipients: [{ id: channels.discord.sender }] };
    } else if (req.method === "POST" && url.pathname === `${discordChannelPath}/messages`) {
      body = {
        id: discordMessage,
        channel_id: channels.discord.current,
        content: "accepted message",
      };
    } else if (req.method === "PUT" && /\/reactions\/[^/]+\/@me$/.test(url.pathname)) {
      res.writeHead(204).end();
      return;
    } else if (isMessageWrite) {
      if (req.method === "PATCH") {
        body = {
          id: messageWriteTarget?.[3],
          channel_id: messageWriteTarget?.[1],
          content: "edited message",
        };
      } else {
        res.writeHead(204).end();
        return;
      }
    } else if (req.method === "GET" && url.pathname === `/api/v10/guilds/${discordGuild}`) {
      body = {
        id: discordGuild,
        owner_id: "100000000000000008",
        roles: [
          { id: discordGuild, permissions: "0" },
          { id: discordManagementRole, permissions: "16" }, // Discord MANAGE_CHANNELS.
        ],
      };
    } else if (
      req.method === "GET" &&
      url.pathname === `/api/v10/guilds/${discordGuild}/members/${channels.discord.sender}`
    ) {
      body = { user: { id: channels.discord.sender }, roles: [discordManagementRole] };
    } else if (req.method === "PATCH" && url.pathname === discordChannelPath) {
      body = {
        id: channels.discord.current,
        type: 0,
        guild_id: discordGuild,
        name: "allowed",
        topic: "A permitted channel topic",
      };
    } else if (url.pathname === "/api/conversations.info") {
      body = { ok: true, channel: { id: fields.channel, is_channel: true, name: "allowed" } };
    } else if (url.pathname === "/api/conversations.history") {
      body = { ok: true, messages: [], has_more: false };
    } else {
      throw new Error(`Unexpected provider request: ${req.method} ${url.pathname}`);
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  }

  beforeAll(async () => {
    const isolatedHome = process.env.OPENCLAW_TEST_HOME;
    if (!isolatedHome) {
      throw new Error("CLI message integration requires the shared isolated test HOME");
    }
    workspaceDir = path.join(isolatedHome, "workspace");
    provider = createServer((req, res) => {
      const work = handleProviderRequest(req, res).catch((error: unknown) => {
        providerErrors.push(error);
        res.destroy();
      });
      providerWork.add(work);
      void work.finally(() => providerWork.delete(work));
    });
    await new Promise<void>((resolve) => {
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected provider TCP address");
    }
    providerOrigin = `http://127.0.0.1:${address.port}`;
    realFetch = globalThis.fetch.bind(globalThis);
    cfg = {
      agents: { defaults: { workspace: workspaceDir } },
      tools: { allow: ["message"] },
      channels: {
        discord: {
          enabled: true,
          token: "synthetic-message-provider-token",
          groupPolicy: "allowlist",
          guilds: { [discordGuild]: { channels: { "*": { enabled: true } } } },
        },
        slack: {
          enabled: true,
          botToken: "synthetic-message-provider-token",
          groupPolicy: "open",
          dm: { groupEnabled: true },
        },
      },
    };
    initialConfig = cfg;
    setRuntimeConfigSnapshot(cfg, cfg);
    await ensureMcpLoopbackServer(0);
    const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "task-owned MCP runtime");
    mcpOrigin = `http://127.0.0.1:${runtime.port}`;
  });

  beforeEach(() => {
    cfg = structuredClone(initialConfig);
    directoryChannelName = `scheduled-edit-${++sequence}`;
    registeredDiscordActions = undefined;
    gatewaySend = false;
    acceptedChannelEdits = 0;
    nextChannelEditStatus = undefined;
    acceptedMessageWrites = 0;
    nextMessageWriteStatus = undefined;
    requests.length = 0;
    providerErrors.length = 0;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "https://discord.com" && url.pathname.startsWith("/api/v10/")) {
        return realFetch(new URL(`${url.pathname}${url.search}`, providerOrigin), init);
      }
      if (url.origin !== providerOrigin && url.origin !== mcpOrigin) {
        throw new Error(`Unexpected fixture network destination: ${url.origin}`);
      }
      return realFetch(input, init);
    });
    vi.stubEnv("SLACK_API_URL", `${providerOrigin}/api/`);
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      vi.stubEnv(key, undefined);
    }
    registerChannelPlugins();
    setRuntimeConfigSnapshot(cfg, cfg);
  });

  function registerChannelPlugins(options: { discordOrigin?: "global" | "bundled" } = {}) {
    const owner = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    // Installer provenance has its own coverage; the official adapters and gates are real.
    for (const plugin of [discordPlugin, slackPlugin]) {
      const origin = plugin.id === "discord" ? (options.discordOrigin ?? "global") : "global";
      const record = createPluginRecord({
        id: plugin.id,
        origin,
        trustedOfficialInstall: origin === "global",
      });
      owner.registry.plugins.push(record);
      const actions: ChannelMessageActionAdapter | undefined = plugin.actions
        ? {
            ...plugin.actions,
            // Only the accepted-send case selects the supported Gateway-owned dispatch branch.
            resolveExecutionMode: (params) =>
              gatewaySend && params.action === "send"
                ? "gateway"
                : (plugin.actions?.resolveExecutionMode?.(params) ?? "local"),
          }
        : undefined;
      if (plugin.id === "discord") {
        registeredDiscordActions = actions;
      }
      owner.createApi(record, { config: cfg, registrationMode: "full" }).registerChannel({
        plugin: {
          ...plugin,
          status: undefined,
          ...(actions ? { actions } : {}),
        },
      });
    }
    setActivePluginRegistry(owner.registry);
  }

  afterEach(async () => {
    heldRequest?.release.resolve();
    heldRequest = undefined;
    for (const cleanup of cleanupTurns.splice(0)) {
      cleanup();
    }
    await Promise.all(providerWork);
    if (providerErrors.length) {
      throw new AggregateError(providerErrors, "Provider fixture failed");
    }
  });

  afterAll(async () => {
    await closeMcpLoopbackServer();
    provider?.closeAllConnections();
    if (provider?.listening) {
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()));
      });
    }
    closeOpenClawStateDatabaseForTest();
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function holdProviderRequest(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    requestPath = `${discordChannelPath}${method === "POST" ? "/messages" : ""}`,
  ) {
    const gate = {
      method,
      path: requestPath,
      entered: createDeferred(),
      release: createDeferred(),
    };
    heldRequest = gate;
    return {
      entered: (pending?: Promise<McpResponse>) =>
        withTestTimeout(
          pending
            ? Promise.race([
                gate.entered.promise,
                pending.then((response) => {
                  throw new Error(
                    `MCP completed before the provider request: ${JSON.stringify(response)}`,
                  );
                }),
              ])
            : gate.entered.promise,
          10_000,
          "Expected provider request was not reached",
        ),
      release: () => gate.release.resolve(),
    };
  }

  async function createTurn(
    channel: keyof typeof channels,
    options: {
      splitSession?: boolean;
      bindCapability?: boolean;
      gatewaySend?: boolean;
      discordDm?: boolean;
      scheduledPolicy?: ScheduledToolPolicyContext;
      channelRequester?: CronAuthenticatedChannelRequester;
      agentAccountId?: string;
    } = {},
  ) {
    gatewaySend = options.gatewaySend === true;
    const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "active MCP runtime");
    const source = new AbortController();
    const scheduledSource = new AbortController();
    const scheduledPolicy = options.scheduledPolicy;
    const runId = `cli-message-${channel}-${++sequence}`;
    const direct = !scheduledPolicy && channel === "discord" && options.discordDm === true;
    const senderId = channels[channel].sender;
    const currentChannelId = direct ? `user:${channels.discord.sender}` : channels[channel].current;
    const policySessionKey = scheduledPolicy
      ? `agent:main:cron:${runId}:run:fixture`
      : direct
        ? `agent:main:discord:default:direct:${channels.discord.sender}`
        : `agent:main:${channel}:channel:${channels[channel].current}`;
    const splitSession = !scheduledPolicy && (options.splitSession || direct);
    const run = {
      sessionId: `session-${runId}`,
      sessionKey: splitSession ? "agent:main:main" : policySessionKey,
      sessionFile: path.join(workspaceDir, `${runId}.jsonl`),
      runId,
      workspaceDir,
      ...(splitSession ? { runtimePolicySessionKey: policySessionKey } : {}),
      provider: "claude-cli" as const,
      model: "test-model",
      prompt: "Inspect the current conversation.",
      timeoutMs: 60_000,
      ...(scheduledPolicy
        ? {
            scheduledToolPolicy: scheduledPolicy,
            trigger: "cron" as const,
            agentAccountId: options.agentAccountId,
          }
        : {
            messageProvider: channel,
            messageChannel: channel,
            // Discord CLI ingress receives the user target; the capability keeps the native DM id.
            currentChannelId,
            ...(direct ? { chatType: "direct" as const, currentMessageId: discordMessage } : {}),
            agentAccountId: "default",
            senderId,
          }),
      senderIsOwner: false,
      cliToolAvailability: { native: [], openClaw: ["message"] },
    } satisfies RunCliAgentParams;
    const admission = prepareAgentRunAdmission({
      cfg,
      facts: {
        runId,
        agentId: "main",
        ingress: {
          kind: scheduledPolicy ? "schedule" : "system",
          boundary: "cli-message-test",
          state: "present",
        },
      },
      operationalRunInstance: createOperationalRunInstanceRef(runId),
    });
    const admitted = await admission.admit("gateway", runId);
    const directToolContext = direct
      ? expectDefined(
          discordPlugin.threading?.buildToolContext?.({
            cfg,
            accountId: "default",
            context: {
              Channel: "discord",
              From: `discord:${senderId}`,
              To: currentChannelId,
              ChatType: "direct",
              NativeChannelId: discordDm,
              CurrentMessageId: discordMessage,
            },
            hasRepliedRef: undefined,
          }),
          "Discord DM threading context",
        )
      : undefined;
    const capability = mintMessageActionTurnCapability({
      agentId: "main",
      runId,
      sessionKey: policySessionKey,
      sourceReplySessionKey: run.sessionKey,
      sessionId: run.sessionId,
      ...(scheduledPolicy
        ? {
            // This fixture owns the source lifetime; the cron producer is covered separately.
            scheduled: {
              policy: scheduledPolicy,
              assertCurrent: () => scheduledSource.signal.throwIfAborted(),
              ...(options.channelRequester ? { channelRequester: options.channelRequester } : {}),
            },
          }
        : {
            requesterAccountId: "default",
            requesterSenderId: senderId,
            toolContext: {
              currentChannelProvider: channel,
              ...(directToolContext ?? {
                currentChannelId,
                currentChatType: "channel" as const,
              }),
            },
          }),
    });
    const grant = mintMcpLoopbackClientGrant({
      context: buildCliMcpGrantContext({
        run,
        config: cfg,
        requireExplicitMessageTarget: Boolean(scheduledPolicy),
        agentId: "main",
        modelProvider: "anthropic",
        modelId: "test-model",
        toolsAllow: ["message"],
      }),
      runtimeOwnerToken: runtime.ownerToken,
      admittedRunContext: admitted,
      messageActionTurnCapability: options.bindCapability === false ? undefined : capability,
      abortSignal: source.signal,
    });
    const capture = {
      token: grant.token,
      runtimeOwnerToken: runtime.ownerToken,
      captureKey: `capture-${runId}`,
    };
    const gatewayContext = {
      trackExecution: trackAsyncWork,
      getRuntimeConfig: () => cfg,
      dedupe: new Map(),
      getGatewayMethodRegistry: () => createRequestGatewayMethodRegistry(),
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    } as GatewayRequestContext;
    bindGatewayContextResolver(admitted, () => gatewayContext);
    cleanupTurns.push(() => {
      source.abort();
      scheduledSource.abort();
      revokeMcpLoopbackClientGrant(grant.token);
      revokeMessageActionTurnCapability(capability);
      clearMcpLoopbackToolCallCapture(capture.captureKey);
      clearGatewayContextResolver(admitted);
      admission.close();
    });
    expect(activateMcpLoopbackClientGrantCapture(capture)).not.toBe(false);
    beginMcpLoopbackToolCallCapture({ captureKey: capture.captureKey, onToolCallResult() {} });
    const rpc = async (
      method: string,
      params?: Record<string, unknown>,
      headers?: Record<string, string>,
    ): Promise<McpResponse> => {
      const response = await realFetch(`${mcpOrigin}/mcp`, {
        method: "POST",
        headers: {
          ...headers,
          authorization: `Bearer ${grant.token}`,
          "content-type": "application/json",
          "x-openclaw-cli-capture-key": capture.captureKey,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++sequence,
          method,
          ...(params ? { params } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = (await response.json()) as McpResponse;
      expect(response.status, JSON.stringify(payload)).toBe(200);
      return payload;
    };
    // Warm discovery so later calls also exercise the grant-owned tool cache.
    const advertisedMessage = expectDefined(
      (await rpc("tools/list")).result?.tools?.find((tool) => tool.name === "message"),
      "advertised message tool",
    );
    return {
      advertisedMessage,
      capability,
      source,
      capture,
      revokeScheduledPermission: () =>
        scheduledSource.abort(new Error("Scheduled source permission revoked.")),
      runParams: {
        ...run,
        agentId: "main",
        config: cfg,
        admittedRunContext: admitted,
        abortSignal: source.signal,
        messageActionTurnCapability: options.bindCapability === false ? undefined : capability,
      },
      isCurrent: () => resolveMcpLoopbackClientGrant(capture)?.isCurrent() === true,
      call: (args: Record<string, unknown>, headers?: Record<string, string>) =>
        rpc("tools/call", { name: "message", arguments: args }, headers),
    };
  }

  it.each(["discord", "slack"] as const)(
    "reads through an official %s CLI grant",
    async (channel) => {
      const turn = await createTurn(channel, { splitSession: channel === "discord" });
      const target = channel === "discord" ? discordSibling : channels.slack.current;
      if (channel === "discord") {
        expect(turn.runParams.sessionKey).not.toBe(turn.runParams.runtimePolicySessionKey);
      }
      expectSuccess(
        await turn.call({ action: "read", channel, target: `channel:${target}`, limit: 1 }),
      );
      expect(requests).toContainEqual(
        expect.objectContaining(
          channel === "discord"
            ? { method: "GET", path: `/api/v10/channels/${target}/messages` }
            : {
                method: "POST",
                path: "/api/conversations.history",
                fields: expect.objectContaining({ channel: target }),
              },
        ),
      );
    },
  );

  it("reacts with bare, prefixed, and default channel targets while rejecting another conversation", async () => {
    const turn = await createTurn("discord");
    for (const target of [
      `channel:${channels.discord.current}`,
      channels.discord.current,
      undefined,
    ]) {
      expectSuccess(await turn.call({ ...react, ...(target ? { target } : {}) }));
    }
    expect(requests.filter((request) => request.method === "PUT")).toEqual([
      expect.objectContaining({
        path: `${discordChannelPath}/messages/${discordMessage}/reactions/%E2%9C%85/@me`,
      }),
      expect.objectContaining({
        path: `${discordChannelPath}/messages/${discordMessage}/reactions/%E2%9C%85/@me`,
      }),
      expect.objectContaining({
        path: `${discordChannelPath}/messages/${discordMessage}/reactions/%E2%9C%85/@me`,
      }),
    ]);
    const before = requests.length;
    expectDenied(
      await turn.call(
        { ...react, target: `channel:${discordSibling}` },
        { "x-openclaw-current-channel-id": discordSibling },
      ),
      /exact current conversation and account/,
    );
    expect(requests).toHaveLength(before);
  });

  it.each([
    { selection: "a prefixed native target", target: `channel:${discordDm}` },
    { selection: "a bare native target", target: discordDm },
    { selection: "an implicit target", target: undefined },
  ])("reacts in a Discord DM with $selection and an implicit account", async ({ target }) => {
    const turn = await createTurn("discord", { discordDm: true });
    expectSuccess(await turn.call({ ...react, ...(target ? { target } : {}) }));
    expect(requests.filter((request) => request.method === "PUT")).toEqual([
      expect.objectContaining({
        path: `/api/v10/channels/${discordDm}/messages/${discordMessage}/reactions/%E2%9C%85/@me`,
      }),
    ]);
  });

  it("pins the current Discord message without an explicit target", async () => {
    const turn = await createTurn("discord");
    expectSuccess(
      await turn.call({ action: "pin", channel: "discord", messageId: discordMessage }),
    );
    expect(requests.filter((request) => request.method === "PUT")).toEqual([
      expect.objectContaining({ path: `${discordChannelPath}/pins/${discordMessage}` }),
    ]);
  });

  it("deletes an explicit message in the current Discord channel", async () => {
    const turn = await createTurn("discord");
    expectSuccess(
      await turn.call({
        action: "delete",
        channel: "discord",
        target: `channel:${channels.discord.current}`,
        messageId: discordMessage,
      }),
    );
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([
      expect.objectContaining({ path: `${discordChannelPath}/messages/${discordMessage}` }),
    ]);
  });

  it("edits the current Discord channel with the admitted sender's permission", async () => {
    const turn = await createTurn("discord");
    expectSuccess(
      await turn.call({
        action: "channel-edit",
        channel: "discord",
        target: `channel:${channels.discord.current}`,
        topic: "A permitted channel topic",
      }),
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: `/api/v10/guilds/${discordGuild}/members/${channels.discord.sender}`,
      }),
    );
    const edits = requests.filter((request) => request.method === "PATCH");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.path).toBe(discordChannelPath);
    expect(JSON.parse(edits[0]?.body ?? "null")).toEqual({ topic: "A permitted channel topic" });
  });

  describe("scheduled channel-edit consumer", () => {
    it("resolves a channel name through the Discord directory before the scheduled edit", async () => {
      const turn = await createTurn("discord", { scheduledPolicy: trustedScheduledPolicy });

      expectSuccess(await turn.call({ ...channelEdit, target: `#${directoryChannelName}` }));

      expect(
        requests.filter(
          (request) =>
            request.path === discordGuildsPath || request.path === discordGuildChannelsPath,
        ),
      ).toEqual([
        expect.objectContaining({ method: "GET", path: discordGuildsPath }),
        expect.objectContaining({ method: "GET", path: discordGuildChannelsPath }),
      ]);
      const edits = requests.filter((request) => request.method === "PATCH");
      expect(edits).toHaveLength(1);
      expect(edits[0]?.path).toBe(discordChannelPath);
      expect(JSON.parse(edits[0]?.body ?? "null")).toEqual({ topic: channelEdit.topic });
      expect(acceptedChannelEdits).toBe(1);
    });

    it.each([
      { retirement: "job permission is revoked", retire: "source" },
      {
        retirement: "the selected plugin registration is replaced",
        retire: "registration",
      },
    ] as const)("stops channel-name lookup after $retirement", async ({ retire }) => {
      const turn = await createTurn("discord", { scheduledPolicy: trustedScheduledPolicy });
      const firstLookup = holdProviderRequest("GET", discordGuildsPath);
      const pending = turn.call({ ...channelEdit, target: `#${directoryChannelName}` });
      try {
        await firstLookup.entered(pending);
        if (retire === "source") {
          turn.revokeScheduledPermission();
        } else {
          registerChannelPlugins();
        }
        firstLookup.release();

        expectDenied(await pending, /no longer active|permission revoked/i);
        expect(requests).toEqual([
          expect.objectContaining({ method: "GET", path: discordGuildsPath }),
        ]);
        expect(acceptedChannelEdits).toBe(0);
      } finally {
        firstLookup.release();
        await pending.catch(() => undefined);
      }
    });

    it.each([
      { name: "an ordinary account job", identity: {}, namedTarget: false },
      { name: "an account job with a channel-name target", identity: {}, namedTarget: true },
      {
        name: "an account job with forged owner and sender arguments",
        namedTarget: false,
        identity: {
          senderIsOwner: true,
          requesterSenderId: channels.discord.sender,
          senderUserId: channels.discord.sender,
          conversationReadOrigin: "direct-operator",
        },
      },
    ])("does not promote $name to administration", async ({ identity, namedTarget }) => {
      const turn = await createTurn("discord", { scheduledPolicy: accountScheduledPolicy });

      expectDenied(
        await turn.call({
          ...channelEdit,
          ...identity,
          target: namedTarget ? `#${directoryChannelName}` : channelEdit.target,
        }),
        /fresh Discord requester authorization/,
      );
      if (namedTarget) {
        expect(requests).toEqual([]);
      }
      expect(requests.filter((request) => request.method === "PATCH")).toEqual([]);
    });

    it.each([
      { origin: "unknown", ownerOrigin: { kind: "unknown" } },
      { origin: "external Slack", ownerOrigin: { kind: "external", channel: "slack" } },
    ] as const)(
      "discovers and invokes the native editor with an $origin read origin",
      async ({ ownerOrigin }) => {
        const discord = expectDefined(cfg.channels?.discord, "configured Discord accounts");
        cfg = {
          ...cfg,
          channels: {
            ...cfg.channels,
            discord: {
              ...discord,
              defaultAccount: "default",
              accounts: {
                default: { actions: { channels: false } },
                work: { token: discordWorkToken, actions: { channels: true } },
              },
            },
          },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const turn = await createTurn("discord", {
          scheduledPolicy: {
            ...accountScheduledPolicy,
            ownerAccountId: "work",
            ownerOrigin,
          },
          channelRequester: { ...channelRequester, accountId: "work" },
          agentAccountId: "default",
        });
        expect(turn.advertisedMessage.inputSchema).toMatchObject({
          properties: { action: { enum: expect.arrayContaining(["channel-edit"]) } },
        });
        expect(turn.advertisedMessage.description).toContain("channel-edit");
        expect(turn.runParams.agentAccountId).toBe("default");
        expect(turn.runParams.senderIsOwner).toBe(false);
        expect(turn.runParams).not.toHaveProperty("senderId");
        expect(turn.runParams).not.toHaveProperty("currentChannelId");
        expectSuccess(
          await turn.call({
            ...channelEdit,
            target: `#${directoryChannelName}`,
            senderIsOwner: true,
            senderUserId: "100000000000000008",
          }),
        );
        expect(requests).toContainEqual(
          expect.objectContaining({
            method: "GET",
            path: `/api/v10/guilds/${discordGuild}/members/${channelRequester.senderId}`,
          }),
        );
        expect(requests.every((request) => request.usesWorkCredential)).toBe(true);
        expect(acceptedChannelEdits).toBe(1);
        const beforeRead = requests.length;
        expectDenied(
          await turn.call({ action: "read", channel: "discord", target: channelEdit.target }),
          /matching recorded creator origin/,
        );
        expect(requests).toHaveLength(beforeRead);
      },
    );

    it.each([
      { ...channelRequester, channel: "slack" },
      { ...channelRequester, accountId: "another-account" },
    ])("does not use a native requester from another channel/account (%j)", async (requester) => {
      const turn = await createTurn("discord", {
        scheduledPolicy: accountScheduledPolicy,
        channelRequester: requester,
      });
      expectDenied(await turn.call(channelEdit), /authenticated requester account and channel/);
      expect(requests).toEqual([]);
    });

    it("stops the next native permission request when the job grant is revoked", async () => {
      const turn = await createTurn("discord", {
        scheduledPolicy: accountScheduledPolicy,
        channelRequester,
      });
      const permissionRead = holdProviderRequest(
        "GET",
        `/api/v10/guilds/${discordGuild}/members/${channelRequester.senderId}`,
      );
      const pending = turn.call(channelEdit);
      try {
        await permissionRead.entered(pending);
        turn.revokeScheduledPermission();
        permissionRead.release();
        expectDenied(await pending, /no longer active|permission revoked/i);
        expect(acceptedChannelEdits).toBe(0);
        expect(requests.filter((request) => request.method === "PATCH")).toEqual([]);
      } finally {
        permissionRead.release();
        await pending.catch(() => undefined);
      }
    });

    it("does not accept scheduled administration authority from tool arguments or headers", async () => {
      const turn = await createTurn("discord", {
        scheduledPolicy: trustedScheduledPolicy,
        bindCapability: false,
      });

      expectDenied(
        await turn.call(
          {
            ...channelEdit,
            senderIsOwner: true,
            requesterSenderId: channels.discord.sender,
            senderUserId: channels.discord.sender,
            messageActionTurnCapability: turn.capability,
            scheduledToolPolicy: trustedScheduledPolicy,
          },
          { "x-openclaw-message-action-turn-capability": turn.capability },
        ),
        /trusted.*sender|operator-authorized/i,
      );
      expect(requests.filter((request) => request.method === "PATCH")).toEqual([]);
    });

    it("requires the registered adapter's write declaration before editing", async () => {
      const actions = expectDefined(registeredDiscordActions, "registered Discord actions");
      delete actions.writeAuthorityActions;
      const turn = await createTurn("discord", { scheduledPolicy: trustedScheduledPolicy });

      expectDenied(
        await turn.call({ ...channelEdit, target: `#${directoryChannelName}` }),
        /write authorization support/,
      );
      expect(requests).toEqual([]);
    });

    it("keeps channel deletion behind the existing trusted sender guard", async () => {
      const turn = await createTurn("discord", { scheduledPolicy: trustedScheduledPolicy });

      expectDenied(
        await turn.call({
          action: "channel-delete",
          channel: "discord",
          target: channelEdit.target,
        }),
        /trusted.*sender/i,
      );
      expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it.each([
      { change: "unchanged authority", revoke: undefined },
      { change: "immediate job revocation", revoke: "source" },
      { change: "prospective action configuration", revoke: "action" },
      { change: "prospective account configuration", revoke: "account" },
    ] as const)("preserves $change across a Discord 429 retry", async ({ revoke }) => {
      const turn = await createTurn("discord", { scheduledPolicy: trustedScheduledPolicy });
      nextChannelEditStatus = 429;
      const rateLimited = holdProviderRequest("PATCH");
      const pending = turn.call(channelEdit);
      try {
        await rateLimited.entered(pending);
        expect(acceptedChannelEdits).toBe(0);
        if (revoke === "source") {
          turn.revokeScheduledPermission();
        } else if (revoke) {
          const discord = expectDefined(cfg.channels?.discord, "configured Discord account");
          cfg = {
            ...cfg,
            channels: {
              ...cfg.channels,
              discord: {
                ...discord,
                ...(revoke === "action"
                  ? { actions: { ...discord.actions, channels: false } }
                  : {
                      accounts: {
                        ...discord.accounts,
                        default: { ...discord.accounts?.default, enabled: false },
                      },
                    }),
              },
            },
          };
          setRuntimeConfigSnapshot(cfg, cfg);
        }
        rateLimited.release();

        const result = await pending;
        if (revoke === "source") {
          expectDenied(result, /agent runtime authority is no longer active/);
        } else {
          expectSuccess(result);
        }
        expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(
          revoke === "source" ? 1 : 2,
        );
        expect(acceptedChannelEdits).toBe(revoke === "source" ? 0 : 1);
        if (revoke === "action" || revoke === "account") {
          const requestCount = requests.length;
          expectDenied(
            await turn.call({ ...channelEdit, target: `#${directoryChannelName}` }),
            /disabled/,
          );
          expect(requests).toHaveLength(requestCount);
          expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(2);
          expect(acceptedChannelEdits).toBe(1);
        }
      } finally {
        rateLimited.release();
        await pending.catch(() => undefined);
      }
    });

    it.each(["operator", "native-account"] as const)(
      "settles an accepted %s edit after scheduled permission is revoked without replay",
      async (kind) => {
        const turn = await createTurn(
          "discord",
          kind === "native-account"
            ? { scheduledPolicy: accountScheduledPolicy, channelRequester }
            : { scheduledPolicy: trustedScheduledPolicy },
        );
        const accepted = holdProviderRequest("PATCH");
        const pending = turn.call(channelEdit);
        try {
          await accepted.entered(pending);
          expect(acceptedChannelEdits).toBe(1);
          turn.revokeScheduledPermission();
          accepted.release();

          expectSuccess(await pending);
          expectDenied(await turn.call(channelEdit), /Scheduled source permission revoked/);
          expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
          expect(acceptedChannelEdits).toBe(1);
        } finally {
          accepted.release();
          await pending.catch(() => undefined);
        }
      },
    );

    it("reports provider permission denial without retrying the edit", async () => {
      const turn = await createTurn("discord", { scheduledPolicy: trustedScheduledPolicy });
      nextChannelEditStatus = 403;

      expectDenied(await turn.call(channelEdit), /Missing Permissions/);
      expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
      expect(acceptedChannelEdits).toBe(0);
    });
  });

  it("does not accept a private capability supplied through child arguments or headers", async () => {
    const turn = await createTurn("discord", { bindCapability: false });
    expect(turn.isCurrent()).toBe(true);
    expectDenied(
      await turn.call(
        {
          action: "read",
          channel: "discord",
          target: `channel:${channels.discord.current}`,
          messageActionTurnCapability: turn.capability,
          conversationReadOrigin: "direct-operator",
        },
        { "x-openclaw-message-action-turn-capability": turn.capability },
      ),
      /current provider and account context/,
    );
    expect(requests).toEqual([]);
  });

  it("rejects a revoked capability after warming the MCP tool cache", async () => {
    const turn = await createTurn("discord");
    revokeMessageActionTurnCapability(turn.capability);
    expect(turn.isCurrent()).toBe(true);
    expectDenied(await turn.call(react), /turn capability.*no longer active/);
    expect(requests).toEqual([]);
  });

  it("cancels a provider lookup before a reaction can be written", async () => {
    const turn = await createTurn("discord");
    const lookup = holdProviderRequest("GET");
    const response = turn.call({ ...react, target: `channel:${channels.discord.current}` });
    try {
      await lookup.entered();
      turn.source.abort();
    } finally {
      lookup.release();
    }
    expectDenied(await response, /abort|cancel|no longer active/i);
    expect(requests).toContainEqual(
      expect.objectContaining({ method: "GET", path: discordChannelPath }),
    );
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("retains an accepted Gateway send result after normal CLI completion", async () => {
    const turn = await createTurn("discord", { gatewaySend: true, bindCapability: false });
    const heldSend = holdProviderRequest("POST");
    const context = buildPreparedCliRunContext({
      ...turn.runParams,
      backend: { command: "/bin/sh", args: [] },
    });
    context.params = turn.runParams;
    context.preparedBackend.mcpClientGrantCapture = {
      transportToken: turn.capture.token,
      adoptProcessToken: vi.fn(),
      revokeProcessToken: vi.fn(),
      activate: (captureKey, assertCurrent) => {
        activateMcpLoopbackClientGrantCapture({ ...turn.capture, captureKey, assertCurrent });
      },
      deactivate: (captureKey) => {
        deactivateMcpLoopbackClientGrantCapture({ ...turn.capture, captureKey });
      },
    };
    const tracking = createCliToolTracking(context);
    const toolCallId = "accepted-gateway-send";
    const args = {
      action: "send",
      channel: "discord",
      target: `channel:${channels.discord.current}`,
      message: "Preserve the accepted message.",
    };
    let pendingSend: ReturnType<typeof turn.call> | undefined;
    let nativeSignal: AbortSignal | undefined;
    let drain: Promise<void> | undefined;
    const recordRunError = vi.fn();
    try {
      await expect(
        runPlugin(
          context,
          async function* (execution) {
            nativeSignal = execution.abortSignal;
            tracking.handleCliToolUseStart({
              toolCallId,
              name: "mcp__openclaw__message",
              kind: "mcp_tool_use",
              args,
            });
            pendingSend = turn.call(args);
            void pendingSend.catch(() => undefined);
            await heldSend.entered();
            yield { ...SUCCESS_RESULT, session_id: turn.runParams.sessionId };
          },
          {
            sessionId: turn.runParams.sessionId,
            activeToolCount: () => (pendingSend ? 1 : 0),
            mcpCapture: {
              captureKey: turn.capture.captureKey,
              beginCapture: tracking.beginGatewayCapture,
            },
          },
        ),
      ).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
      expect(nativeSignal?.aborted).toBe(true);
      drain = tracking.finishDeliveryTracking({
        useManagedClaudeLiveSession: false,
        recordRunError,
      });
      heldSend.release();
      const response = await expectDefined(pendingSend, "accepted MCP message request");
      await drain;
      expect(response).toMatchObject({ result: { isError: false } });
      expect(JSON.stringify(response)).toContain(discordMessage);
      expect(tracking.resolveCliLoopbackTerminalOutcome(toolCallId)).toEqual({
        outcome: "completed",
      });
      expect(tracking.withExecutionEvidence({ text: "completed" }).didSendViaMessagingTool).toBe(
        true,
      );
      expect(recordRunError).not.toHaveBeenCalled();
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    } finally {
      heldSend.release();
      await pendingSend?.catch(() => undefined);
      await drain;
      tracking.finalizeCapture(() => {});
    }
    expect(turn.isCurrent()).toBe(false);
  });

  describe("scheduled message management", () => {
    const messageTarget = {
      channel: "discord",
      target: `channel:${channels.discord.current}`,
      messageId: discordMessage,
    };
    const editedContent = "A permitted scheduled message edit";
    const writes = [
      { action: "edit", method: "PATCH", path: discordMessagePath },
      { action: "delete", method: "DELETE", path: discordMessagePath },
      { action: "pin", method: "PUT", path: discordPinPath },
      { action: "unpin", method: "DELETE", path: discordPinPath },
    ] as const;

    it.each(
      [
        { principal: "trusted", scheduledPolicy: trustedScheduledPolicy },
        { principal: "account", scheduledPolicy: accountScheduledPolicy },
      ].flatMap(({ principal, scheduledPolicy }) =>
        writes.map(({ action, method, path: requestPath }) => ({
          principal,
          scheduledPolicy,
          action,
          method,
          path: requestPath,
        })),
      ),
    )(
      "dispatches $action through the provider route for a $principal scheduled job",
      async ({ scheduledPolicy, action, method, path: requestPath }) => {
        const turn = await createTurn("discord", { scheduledPolicy });

        expectSuccess(
          await turn.call({
            ...messageTarget,
            action,
            ...(action === "edit" ? { message: editedContent } : {}),
          }),
        );

        const mutations = requests.filter((request) => request.method !== "GET");
        expect(mutations).toEqual([expect.objectContaining({ method, path: requestPath })]);
        if (action === "edit") {
          expect(JSON.parse(mutations[0]?.body ?? "null")).toEqual({ content: editedContent });
        } else {
          expect(mutations[0]?.body).toBe("");
        }
      },
    );

    it.each([
      { action: "edit", gate: "messages" },
      { action: "pin", gate: "pins" },
    ] as const)("retains the $gate action gate for scheduled $action", async ({ action, gate }) => {
      const turn = await createTurn("discord", { scheduledPolicy: accountScheduledPolicy });
      const discord = expectDefined(cfg.channels?.discord, "configured Discord account");
      cfg = {
        ...cfg,
        channels: {
          ...cfg.channels,
          discord: { ...discord, actions: { ...discord.actions, [gate]: false } },
        },
      };
      setRuntimeConfigSnapshot(cfg, cfg);

      expectDenied(
        await turn.call({
          ...messageTarget,
          action,
          ...(action === "edit" ? { message: editedContent } : {}),
        }),
        /message edits are disabled|pins are disabled|is disabled for this account/,
      );
      expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it.each([
      {
        boundary: "another configured account",
        scheduledPolicy: accountScheduledPolicy,
        args: { accountId: "other" },
        reason: /cannot use another creator account/,
      },
      {
        boundary: "a forbidden target for an account job",
        scheduledPolicy: accountScheduledPolicy,
        args: { target: `channel:${discordSibling}` },
        reason: /Discord read target channel is not allowed/,
      },
      {
        boundary: "a forbidden target for a trusted job",
        scheduledPolicy: trustedScheduledPolicy,
        args: { target: `channel:${discordSibling}` },
        reason: /Discord read target channel is not allowed/,
      },
    ])("denies $boundary before message mutation", async ({ scheduledPolicy, args, reason }) => {
      const discord = expectDefined(cfg.channels?.discord, "configured Discord account");
      cfg = {
        ...cfg,
        channels: {
          ...cfg.channels,
          discord: {
            ...discord,
            accounts: {
              ...discord.accounts,
              other: { token: "synthetic-other-message-provider-token" },
            },
            guilds: {
              [discordGuild]: {
                channels: {
                  [channels.discord.current]: { enabled: true },
                  [discordSibling]: { enabled: false },
                },
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      const turn = await createTurn("discord", { scheduledPolicy });

      expectDenied(await turn.call({ ...messageTarget, action: "delete", ...args }), reason);
      expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it("allows an account job to pin in another conversation permitted by Discord policy", async () => {
      const turn = await createTurn("discord", { scheduledPolicy: accountScheduledPolicy });

      expectSuccess(
        await turn.call({ ...messageTarget, action: "pin", target: `channel:${discordSibling}` }),
      );

      expect(requests.filter((request) => request.method !== "GET")).toEqual([
        expect.objectContaining({
          method: "PUT",
          path: `/api/v10/channels/${discordSibling}/pins/${discordMessage}`,
        }),
      ]);
    });

    it("resolves a channel-name target for an account-bound pin", async () => {
      const turn = await createTurn("discord", { scheduledPolicy: accountScheduledPolicy });

      expectSuccess(
        await turn.call({
          ...messageTarget,
          action: "pin",
          target: `#${directoryChannelName}`,
        }),
      );

      expect(
        requests.filter(
          (request) =>
            request.path === discordGuildsPath || request.path === discordGuildChannelsPath,
        ),
      ).toEqual([
        expect.objectContaining({ method: "GET", path: discordGuildsPath }),
        expect.objectContaining({ method: "GET", path: discordGuildChannelsPath }),
      ]);
      expect(requests.filter((request) => request.method !== "GET")).toEqual([
        expect.objectContaining({ method: "PUT", path: discordPinPath }),
      ]);
    });

    it("settles an accepted delete after job permission revocation and blocks the next call", async () => {
      const turn = await createTurn("discord", { scheduledPolicy: accountScheduledPolicy });
      const accepted = holdProviderRequest("DELETE", discordMessagePath);
      const args = { ...messageTarget, action: "delete" };
      const pending = turn.call(args);
      try {
        await accepted.entered(pending);
        expect(acceptedMessageWrites).toBe(1);
        turn.revokeScheduledPermission();
        accepted.release();

        expectSuccess(await pending);
        const requestCount = requests.length;
        expectDenied(await turn.call(args), /Scheduled source permission revoked/);
        expect(requests).toHaveLength(requestCount);
        expect(requests.filter((request) => request.method !== "GET")).toEqual([
          expect.objectContaining({ method: "DELETE", path: discordMessagePath }),
        ]);
        expect(acceptedMessageWrites).toBe(1);
      } finally {
        accepted.release();
        await pending.catch(() => undefined);
      }
    });

    it("reports a provider-denied unpin without another mutation attempt", async () => {
      const turn = await createTurn("discord", { scheduledPolicy: accountScheduledPolicy });
      nextMessageWriteStatus = 403;

      expectDenied(await turn.call({ ...messageTarget, action: "unpin" }), /Missing Permissions/);

      expect(requests.filter((request) => request.method !== "GET")).toEqual([
        expect.objectContaining({ method: "DELETE", path: discordPinPath }),
      ]);
    });

    it("preserves installed interactive pin admission without a write declaration", async () => {
      const actions = expectDefined(registeredDiscordActions, "registered Discord actions");
      delete actions.writeAuthorityActions;
      const turn = await createTurn("discord");

      expectSuccess(await turn.call({ ...messageTarget, action: "pin" }));
      const requestCount = requests.length;
      expectDenied(
        await turn.call({ ...messageTarget, action: "pin", target: `channel:${discordSibling}` }),
        /exact current conversation and account/,
      );
      const scheduledTurn = await createTurn("discord", {
        scheduledPolicy: accountScheduledPolicy,
      });
      expectDenied(
        await scheduledTurn.call({ ...messageTarget, action: "pin" }),
        /write authorization support/,
      );

      expect(requests).toHaveLength(requestCount);
      expect(requests.filter((request) => request.method !== "GET")).toEqual([
        expect.objectContaining({ method: "PUT", path: discordPinPath }),
      ]);
    });

    it("keeps bundled interactive pins but denies undeclared scheduled writes", async () => {
      registerChannelPlugins({ discordOrigin: "bundled" });
      const actions = expectDefined(registeredDiscordActions, "bundled Discord actions");
      delete actions.writeAuthorityActions;

      const interactiveTurn = await createTurn("discord");
      expectSuccess(
        await interactiveTurn.call({
          ...messageTarget,
          action: "pin",
          target: `channel:${discordSibling}`,
        }),
      );
      const requestCount = requests.length;
      const mismatchedOriginPolicy: ScheduledToolPolicyContext = {
        ...accountScheduledPolicy,
        ownerSessionKey: `agent:main:slack:channel:${channels.slack.current}`,
        ownerOrigin: { kind: "external", channel: "slack" },
      };

      const mismatchedOriginTurn = await createTurn("discord", {
        scheduledPolicy: mismatchedOriginPolicy,
      });
      expectDenied(
        await mismatchedOriginTurn.call({
          ...messageTarget,
          action: "pin",
          target: `channel:${discordSibling}`,
        }),
        /matching recorded creator origin/,
      );
      const undeclaredTurn = await createTurn("discord", {
        scheduledPolicy: accountScheduledPolicy,
      });
      expectDenied(
        await undeclaredTurn.call({
          ...messageTarget,
          action: "pin",
          target: `channel:${discordSibling}`,
        }),
        /write authorization support/,
      );
      expect(requests).toHaveLength(requestCount);
      expect(requests.filter((request) => request.method !== "GET")).toEqual([
        expect.objectContaining({
          method: "PUT",
          path: `/api/v10/channels/${discordSibling}/pins/${discordMessage}`,
        }),
      ]);
    });
  });
});

import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { discordPlugin } from "../../extensions/discord/api.js";
import { slackPlugin } from "../../extensions/slack/api.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { buildCliMcpGrantContext } from "../agents/cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../agents/cli-runner/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import type { Deferred } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-identity-token.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  getActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "./message-action-turn-capability.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export const destinations = {
  discord: {
    current: "100000000000000003",
    sibling: "100000000000000004",
    sender: "100000000000000009",
  },
  slack: { current: "C0123456789", sibling: "C9876543210", sender: "U0123456789" },
};
export const discordGuild = "100000000000000001";
export const discordGuildOwner = "100000000000000008";
export const discordMessage = "100000000000000020";
export type MessageProvider = keyof typeof destinations;
export type McpMessageResponse = {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: unknown;
};

type ProviderRequest = { method: string; path: string; fields: Record<string, string> };
type CapabilityState = "missing" | "forged" | "expired" | "revoked" | "other-run";

export function useMcpMessageActions(channel: MessageProvider) {
  const requests: ProviderRequest[] = [];
  const cleanupTurns: Array<() => void> = [];
  const current = destinations[channel];
  let provider: Server;
  let mcpOrigin: string;
  let providerOrigin: string;
  let cfg: OpenClawConfig;
  let workspaceDir: string;
  let sequence = 0;
  let realFetch: typeof fetch;
  let heldMetadata: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  let heldSend: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  let gatewaySend = false;

  beforeAll(async () => {
    const isolatedHome = process.env.OPENCLAW_TEST_HOME;
    if (!isolatedHome) {
      throw new Error("MCP message tests require the shared isolated test HOME.");
    }
    workspaceDir = path.join(isolatedHome, "workspace");
    provider = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://fixture.invalid");
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const fields = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      requests.push({ method: req.method ?? "", path: url.pathname, fields });
      let body: unknown;
      if (req.method === "GET" && /^\/api\/v10\/channels\/\d+$/.test(url.pathname)) {
        const gate = heldMetadata;
        heldMetadata = undefined;
        gate?.entered.resolve();
        await gate?.release.promise;
        body = {
          id: url.pathname.split("/").at(-1),
          type: 0,
          guild_id: discordGuild,
          name: "allowed",
          permission_overwrites: [],
        };
      } else if (req.method === "GET" && /\/channels\/\d+\/messages$/.test(url.pathname)) {
        body = [];
      } else if (req.method === "POST" && /\/channels\/\d+\/messages$/.test(url.pathname)) {
        heldSend?.entered.resolve();
        await heldSend?.release.promise;
        heldSend = undefined;
        body = { id: discordMessage, channel_id: current.current, content: "accepted message" };
      } else if (req.method === "PUT" && /\/reactions\/[^/]+\/@me$/.test(url.pathname)) {
        res.writeHead(204);
        res.end();
        return;
      } else if (req.method === "GET" && url.pathname === `/api/v10/guilds/${discordGuild}`) {
        body = {
          id: discordGuild,
          owner_id: discordGuildOwner,
          roles: [{ id: discordGuild, permissions: "0" }],
        };
      } else if (
        req.method === "GET" &&
        url.pathname === `/api/v10/guilds/${discordGuild}/members/${destinations.discord.sender}`
      ) {
        body = { user: { id: destinations.discord.sender }, roles: [] };
      } else if (url.pathname === "/api/users.info") {
        body = { ok: true, user: { id: fields.user, name: "current-requester" } };
      } else if (url.pathname === "/api/conversations.info") {
        body = { ok: true, channel: { id: fields.channel, is_channel: true, name: "allowed" } };
      } else if (url.pathname === "/api/conversations.history") {
        body = { ok: true, messages: [], has_more: false };
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unexpected provider fixture request" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => {
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected provider fixture TCP address.");
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
          accounts: { other: { token: "synthetic-other-account-token" } },
        },
        slack: {
          enabled: true,
          botToken: "synthetic-message-provider-token",
          groupPolicy: "open",
          dm: { groupEnabled: true },
          accounts: { other: { botToken: "synthetic-other-account-token" } },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    await ensureMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    if (!runtime) {
      throw new Error("Expected task-owned MCP runtime.");
    }
    mcpOrigin = `http://127.0.0.1:${runtime.port}`;
  });

  beforeEach(() => {
    gatewaySend = false;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "https://discord.com" && url.pathname.startsWith("/api/v10/")) {
        return realFetch(new URL(`${url.pathname}${url.search}`, providerOrigin), init);
      }
      if (url.origin !== providerOrigin && url.origin !== mcpOrigin) {
        throw new Error(`Unexpected network destination in message fixture: ${url.origin}`);
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
    const owner = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    // Installer provenance has its own coverage; the official adapters and gates are real.
    for (const plugin of [discordPlugin, slackPlugin]) {
      const record = createPluginRecord({
        id: plugin.id,
        origin: "global",
        trustedOfficialInstall: true,
      });
      owner.registry.plugins.push(record);
      owner.createApi(record, { config: cfg, registrationMode: "full" }).registerChannel({
        plugin: {
          ...plugin,
          status: undefined,
          ...(plugin.actions
            ? {
                actions: {
                  ...plugin.actions,
                  // The drain proof selects supported Gateway-owned send dispatch;
                  // its message handler, authorization, and provider transport stay real.
                  resolveExecutionMode: (params) =>
                    gatewaySend && params.action === "send"
                      ? "gateway"
                      : (plugin.actions?.resolveExecutionMode?.(params) ?? "local"),
                },
              }
            : {}),
        },
      });
    }
    setActivePluginRegistry(owner.registry);
    setRuntimeConfigSnapshot(cfg, cfg);
  });

  afterEach(() => {
    heldMetadata?.release.resolve();
    heldMetadata = undefined;
    heldSend?.release.resolve();
    heldSend = undefined;
    for (const cleanup of cleanupTurns.splice(0)) {
      cleanup();
    }
    requests.length = 0;
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

  return {
    requests,
    holdNextMetadata() {
      const gate = { entered: createDeferred(), release: createDeferred() };
      heldMetadata = gate;
      return {
        entered: () =>
          withTestTimeout(
            gate.entered.promise,
            10_000,
            "Provider authorization lookup was not reached",
          ),
        release: () => gate.release.resolve(),
      };
    },
    holdNextSend() {
      const gate = { entered: createDeferred(), release: createDeferred() };
      heldSend = gate;
      return {
        entered: () =>
          withTestTimeout(gate.entered.promise, 10_000, "Provider send was not reached"),
        release: () => gate.release.resolve(),
      };
    },
    async createTurn(
      options: {
        capability?: CapabilityState;
        sourceReplyOnly?: boolean;
        splitSession?: boolean;
        deliveryProbe?: boolean;
        gatewaySend?: boolean;
      } = {},
    ) {
      const runtime = getActiveMcpLoopbackRuntime();
      if (!runtime) {
        throw new Error("Expected active MCP runtime.");
      }
      const toolsAllow = options.deliveryProbe ? ["message", "mcp_delivery_probe"] : ["message"];
      const config = options.deliveryProbe
        ? { ...cfg, tools: { ...cfg.tools, allow: toolsAllow } }
        : cfg;
      if (options.deliveryProbe) {
        setRuntimeConfigSnapshot(config, config);
      }
      gatewaySend = options.gatewaySend === true;
      const runId = `cli-message-${channel}-${++sequence}`;
      const policySessionKey = `agent:main:${channel}:channel:${current.current}`;
      const sessionKey = options.splitSession ? "agent:main:main" : policySessionKey;
      const sessionId = `session-${runId}`;
      const source = new AbortController();
      const admission = prepareAgentRunAdmission({
        cfg: config,
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "cli-message-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      const admitted = await admission.admit("gateway", runId);
      const gatewayContext = {
        trackExecution: trackAsyncWork,
        getRuntimeConfig: () => config,
        dedupe: new Map(),
        getGatewayMethodRegistry: () => createRequestGatewayMethodRegistry(),
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      } as GatewayRequestContext;
      bindGatewayContextResolver(admitted, () => gatewayContext);
      const captureKey = `capture-${runId}`;
      cleanupTurns.push(() => {
        source.abort();
        clearMcpLoopbackToolCallCapture(captureKey);
        clearGatewayContextResolver(admitted);
        admission.close();
      });
      const run = {
        sessionId,
        sessionKey,
        runId,
        workspaceDir,
        sessionFile: path.join(workspaceDir, `${sessionId}.jsonl`),
        ...(options.splitSession ? { runtimePolicySessionKey: policySessionKey } : {}),
        provider: "claude-cli",
        model: "test-model",
        prompt: "Inspect the current conversation.",
        timeoutMs: 60_000,
        messageProvider: channel,
        messageChannel: channel,
        currentChannelId: current.current,
        agentAccountId: "default",
        senderId: current.sender,
        senderIsOwner: false,
        cliToolAvailability: { native: [], openClaw: toolsAllow },
      } satisfies RunCliAgentParams;
      const context = buildCliMcpGrantContext({
        run,
        config,
        requireExplicitMessageTarget: false,
        agentId: "main",
        modelProvider: "anthropic",
        modelId: "test-model",
        toolsAllow,
      });
      const capability =
        options.capability === "forged"
          ? "unminted-turn-capability"
          : mintMessageActionTurnCapability({
              agentId: "main",
              runId: options.capability === "other-run" ? `${runId}-other` : runId,
              sessionKey: policySessionKey,
              sourceReplySessionKey: sessionKey,
              sessionId,
              requesterAccountId: "default",
              requesterSenderId: current.sender,
              toolContext: {
                currentChannelProvider: channel,
                currentChannelId: current.current,
                currentChatType: "channel",
              },
              ...(options.capability === "expired" ? { nowMs: 1, ttlMs: 1 } : {}),
            });
      cleanupTurns.push(() => revokeMessageActionTurnCapability(capability));
      const grant = mintMcpLoopbackClientGrant({
        context: { ...context, ...(options.sourceReplyOnly ? { sourceReplyOnly: true } : {}) },
        runtimeOwnerToken: runtime.ownerToken,
        admittedRunContext: admitted,
        messageActionTurnCapability: options.capability === "missing" ? undefined : capability,
        abortSignal: source.signal,
      });
      cleanupTurns.push(() => revokeMcpLoopbackClientGrant(grant.token));
      const capture = { token: grant.token, runtimeOwnerToken: runtime.ownerToken, captureKey };
      expect(activateMcpLoopbackClientGrantCapture(capture)).not.toBe(false);
      beginMcpLoopbackToolCallCapture({ captureKey, onToolCallResult() {} });
      const rpc = async (
        method: string,
        params?: Record<string, unknown>,
        headers?: Record<string, string>,
      ): Promise<McpMessageResponse> => {
        const response = await realFetch(`${mcpOrigin}/mcp`, {
          method: "POST",
          headers: {
            ...headers,
            authorization: `Bearer ${grant.token}`,
            "content-type": "application/json",
            "x-openclaw-cli-capture-key": captureKey,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++sequence,
            method,
            ...(params ? { params } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const payload = (await response.json()) as McpMessageResponse;
        expect(response.status, JSON.stringify(payload)).toBe(200);
        return payload;
      };
      // Warm discovery must retain exactly the same private authority on tools/call.
      const listed = await rpc("tools/list");
      expect(listed.result?.tools?.some((tool) => tool.name === "message")).toBe(true);
      if (options.deliveryProbe) {
        expect(listed.result?.tools?.some((tool) => tool.name === "mcp_delivery_probe")).toBe(true);
      }
      if (options.capability === "revoked") {
        revokeMessageActionTurnCapability(capability);
      }
      return {
        capability,
        source,
        sessionKey,
        policySessionKey,
        capture,
        gatewayContext,
        runParams: {
          ...run,
          agentId: "main",
          config,
          admittedRunContext: admitted,
          abortSignal: source.signal,
          messageActionTurnCapability: capability,
        },
        isCurrent: () => resolveMcpLoopbackClientGrant(capture)?.isCurrent() === true,
        call: (args: Record<string, unknown>, headers?: Record<string, string>) =>
          rpc("tools/call", { name: "message", arguments: args }, headers),
        callDeliveryProbe: () => rpc("tools/call", { name: "mcp_delivery_probe", arguments: {} }),
      };
    },
  };
}

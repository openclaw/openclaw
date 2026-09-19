import { createServer } from "node:http";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../extensions/discord/api.js";
import { slackPlugin } from "../extensions/slack/api.js";
import { createOperationalRunInstanceRef } from "../src/agents/admitted-run-context.js";
import { wrapToolWithGatewayCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionContext } from "../src/channels/plugins/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
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

const endpointPreparation = vi.hoisted(() => ({
  beforeLookup: undefined as (() => void) | undefined,
}));
vi.mock("node:dns/promises", async (original) => {
  const actual = await original<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: (...args: Parameters<typeof actual.lookup>) => {
      endpointPreparation.beforeLookup?.();
      return actual.lookup(...args);
    },
  };
});

function createOriginatingRun(
  channel: string,
  mode: string,
  requester: {
    accountId?: string;
    senderId?: string;
    toolContext?: ChannelMessageActionContext["toolContext"];
  } = {},
) {
  const sessionKey = `agent:main:${channel}:channel:origin`;
  const operationalRunInstance = createOperationalRunInstanceRef(`read-${channel}-${mode}`);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const requesterAccountId = requester.accountId ?? "default";
  const requesterSenderId = requester.senderId ?? "synthetic-requester";
  const toolContext = {
    currentChannelProvider: channel,
    currentChannelId: channel === "discord" ? current : "C9876543210",
    currentChatType: "channel" as const,
    ...requester.toolContext,
  };
  const turnCapability = mintMessageActionTurnCapability({
    agentId: "main",
    runId: operationalRunInstance.runId,
    sessionKey,
    requesterAccountId,
    requesterSenderId,
    toolContext,
  });
  const runGuard = createAgentRuntimeAuthorityGuard(
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
  if (!runGuard) {
    throw new Error("Expected originating run authority");
  }
  runGuard();
  return {
    wrapTool: (tool: ReturnType<typeof createMessageTool>) =>
      wrapToolWithGatewayCallerIdentity(tool, {
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        receiptAuthority: () => validateAgentRunDelegatedAuthority(delegatedAuthority),
      }),
    toolOptions: {
      agentId: "main",
      agentAccountId: requesterAccountId,
      agentSessionKey: sessionKey,
      runId: operationalRunInstance.runId,
      messageActionTurnCapability: turnCapability,
      ...toolContext,
    },
    actionContext: { requesterAccountId, requesterSenderId, toolContext },
    assert: runGuard,
    revoke: () =>
      mode.includes("claim")
        ? releaseAgentRunDelegatedAuthority(delegatedAuthority)
        : revokeMessageActionTurnCapability(turnCapability),
    dispose: () => {
      revokeMessageActionTurnCapability(turnCapability);
      releaseAgentRunDelegatedAuthority(delegatedAuthority);
    },
  };
}

const guild = "100000000000000001";
const parent = "100000000000000002";
const current = "100000000000000003";
const sibling = "100000000000000004";
const slackTarget = "C0123456789";

function confineProviderFetch(channel: "discord" | "slack", baseUrl: string): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // No synthetic credential can escape to a real provider.
    if (channel === "discord") {
      if (url.origin === baseUrl) {
        return realFetch(input, init);
      }
      expect(url.origin).toBe("https://discord.com");
      expect(url.pathname).toMatch(/^\/api\/v10\//);
      return realFetch(new URL(`${url.pathname}${url.search}`, baseUrl), init);
    }
    expect(url.origin).toBe(baseUrl);
    return realFetch(input, init);
  });
  vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
  for (const key of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    vi.stubEnv(key, undefined);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  endpointPreparation.beforeLookup = undefined;
});

// Registrar trust is a fixture here; installer/loader provenance has separate coverage.
// Responses and the terminal request log come from a real loopback HTTP server.
describe.each(["discord", "slack"] as const)("official %s provider read boundary", (channel) => {
  const modes = [
    "allowed",
    "denied",
    "account",
    "revoked",
    "result-revoked",
    "legacy",
    "run-revoked-direct",
    "run-result-revoked-direct",
    "bundled-allowed",
    "bundled-revoked",
    "bundled-run-revoked-direct",
    "bundled-run-result-revoked-direct",
  ] as const;
  const cases =
    channel === "discord"
      ? [
          ...modes,
          "endpoint-allowed" as const,
          "endpoint-lookup-revoked" as const,
          "endpoint-content-lookup-revoked" as const,
        ]
      : [
          ...modes,
          "tool-allowed" as const,
          "tool-run-preparation-revoked" as const,
          "tool-run-revoked" as const,
          "tool-run-claim-revoked" as const,
          "tool-run-result-revoked" as const,
          "tool-run-retry-revoked" as const,
          "bundled-tool-allowed" as const,
          "bundled-tool-run-claim-revoked" as const,
        ];
  it.each(cases)("routes a cross-conversation read through the provider (%s)", async (mode) => {
    const owner = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const bundledRegistration = mode.startsWith("bundled-");
    const record = createPluginRecord({
      id: channel,
      origin: bundledRegistration ? "bundled" : "global",
      trustedOfficialInstall: !bundledRegistration,
    });
    const provider = channel === "discord" ? discordPlugin : slackPlugin;
    const plugin = {
      ...provider,
      // Status probes have provider-specific generics and are not part of message dispatch.
      status: undefined,
      actions: {
        ...provider.actions!,
        readAuthorityActions:
          mode === "legacy" ? undefined : provider.actions?.readAuthorityActions,
      },
    };
    owner.registry.plugins.push(record);
    owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({ plugin });
    setActivePluginRegistry(owner.registry);
    const usesMessageTool = mode.includes("tool-");
    const runRevocation = mode.includes("run-");
    const resultRevocation = mode.includes("result");
    const run = runRevocation || usesMessageTool ? createOriginatingRun(channel, mode) : undefined;
    const requests: string[] = [];
    const isContent = (url: string) =>
      url.includes("/messages") || url.includes("conversations.history");
    const server = createServer((request, response) => {
      const url = request.url!;
      requests.push(url);
      request.resume();
      let body: unknown;
      if (isContent(url)) {
        if (mode === "result-revoked") {
          record.enabled = false;
        }
        if (runRevocation && resultRevocation) {
          run?.revoke();
        }
        body = channel === "discord" ? [] : { ok: true, messages: [], has_more: false };
      } else {
        if (runRevocation && !resultRevocation) {
          run?.revoke();
        }
        if (mode === "revoked" || mode === "bundled-revoked") {
          record.enabled = false;
        }
        if (channel === "slack" && url.startsWith("/api/conversations.info")) {
          body = {
            ok: true,
            channel: {
              id: slackTarget,
              name: mode === "denied" ? "forbidden" : "allowed",
              is_channel: true,
            },
          };
        } else if (url.endsWith(`/channels/${sibling}`)) {
          body = { id: sibling, type: 11, parent_id: parent, guild_id: guild, name: "sibling" };
        } else if (url.endsWith(`/channels/${parent}`)) {
          body = { id: parent, type: 0, guild_id: guild, name: "discussion" };
        } else {
          response.writeHead(404);
          response.end();
          return;
        }
      }
      const retryMetadata =
        mode === "tool-run-retry-revoked" && !isContent(url) && requests.length === 1;
      response.writeHead(retryMetadata ? 429 : 200, {
        "content-type": "application/json",
        "retry-after": "0",
      });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let endpointLookups = 0;
    if (mode.startsWith("endpoint-")) {
      vi.stubEnv("DISCORD_API_URL", `${baseUrl}/api/v10`);
      endpointPreparation.beforeLookup = () => {
        endpointLookups += 1;
        if (
          mode === "endpoint-lookup-revoked" ||
          (mode === "endpoint-content-lookup-revoked" &&
            requests.some((url) => url.endsWith(`/channels/${parent}`)))
        ) {
          record.enabled = false;
        }
      };
    }
    confineProviderFetch(channel, baseUrl);
    try {
      const actionContext: ChannelMessageActionContext = {
        cfg: {
          channels: {
            discord: {
              enabled: true,
              token: "synthetic-provider-fixture",
              groupPolicy: "allowlist",
              guilds: { [guild]: { channels: { [parent]: { enabled: mode !== "denied" } } } },
            },
            slack: {
              enabled: true,
              botToken: "synthetic-provider-fixture",
              groupPolicy: "allowlist",
              dangerouslyAllowNameMatching: true,
              channels: { "#allowed": { enabled: true } },
            },
          },
        },
        channel,
        action: "read" as const,
        params: { channelId: channel === "discord" ? sibling : slackTarget, limit: 1 },
        accountId: "default",
        requesterAccountId: mode === "account" ? "other" : "default",
        conversationReadOrigin: "delegated" as const,
        assertDirectAdapterHandoff: run?.assert,
        toolContext: {
          currentChannelProvider: channel,
          currentChannelId: channel === "discord" ? current : "C9876543210",
        },
      };
      if (usesMessageTool) {
        setRuntimeConfigSnapshot(actionContext.cfg, actionContext.cfg);
      }
      const messageTool = usesMessageTool
        ? run!.wrapTool(
            createMessageTool({
              ...run!.toolOptions,
              config: actionContext.cfg,
              getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
              resolveCommandSecretRefsViaGateway: async ({ config }) => {
                if (mode === "tool-run-preparation-revoked") {
                  run!.revoke();
                }
                return {
                  resolvedConfig: config,
                  diagnostics: [],
                  targetStatesByPath: {},
                  hadUnresolvedTargets: false,
                };
              },
            }),
          )
        : undefined;
      const invocation = messageTool
        ? messageTool.execute("read-context", {
            action: "read",
            channel,
            target: `channel:${slackTarget}`,
            limit: 1,
          })
        : dispatchChannelMessageAction(actionContext);
      if (mode.endsWith("allowed")) {
        expect(await invocation).not.toBeNull();
        expect(requests.filter(isContent)).toHaveLength(1);
      } else {
        const outcome = await invocation.then(
          () => ({ rejected: false, message: "" }),
          (error: unknown) => ({
            rejected: true,
            message: error instanceof Error ? error.message : "non-Error rejection",
          }),
        );
        expect(outcome.rejected).toBe(true);
        expect(outcome.message).toContain(
          mode === "legacy"
            ? "exact current conversation"
            : mode === "account"
              ? "current provider and account"
              : mode === "denied"
                ? "not allowed"
                : "no longer active",
        );
        expect(requests.filter(isContent)).toHaveLength(
          mode === "result-revoked" || (runRevocation && resultRevocation) ? 1 : 0,
        );
        if (mode === "legacy" || mode === "account" || mode === "tool-run-preparation-revoked") {
          expect(requests).toEqual([]);
        }
        if (
          mode === "revoked" ||
          mode === "bundled-revoked" ||
          mode === "tool-run-revoked" ||
          mode === "tool-run-claim-revoked" ||
          mode === "bundled-tool-run-claim-revoked" ||
          mode === "tool-run-retry-revoked"
        ) {
          expect(requests).toHaveLength(1);
        }
        if (mode === "endpoint-lookup-revoked") {
          expect(endpointLookups).toBeGreaterThan(0);
          expect(requests).toEqual([]);
        }
        if (mode === "endpoint-content-lookup-revoked") {
          expect(endpointLookups).toBeGreaterThan(1);
          expect(requests.filter(isContent)).toEqual([]);
        }
      }
    } finally {
      run?.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

const slackMetadataActions = ["member-info", "emoji-list"] as const;
type SlackMetadataAction = (typeof slackMetadataActions)[number];
const slackRequester = "U0123456789";
const slackOtherMember = "U9999999999";
const slackWorkspace = "T0123456789";
const slackCurrentTarget = `team:${slackWorkspace}:channel:${slackTarget}`;

type SlackMetadataHarness = {
  record: ReturnType<typeof createPluginRecord>;
  run: ReturnType<typeof createOriginatingRun>;
  tool: ReturnType<typeof createMessageTool>;
  context: ChannelMessageActionContext;
  requests: { path: string; fields: Record<string, string>; authorization?: string }[];
  response: { beforeReply?: () => void; error?: string };
};

async function withSlackMetadataHarness(
  exercise: (harness: SlackMetadataHarness) => Promise<void>,
  options: {
    registration?: "official" | "bundled" | "legacy" | "unverified";
    claim?: boolean;
  } = {},
) {
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "slack",
    origin: options.registration === "bundled" ? "bundled" : "global",
    trustedOfficialInstall:
      options.registration !== "unverified" && options.registration !== "bundled",
  });
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({
    plugin: {
      ...slackPlugin,
      status: undefined,
      actions: {
        ...slackPlugin.actions!,
        readAuthorityActions:
          options.registration === "legacy" ? undefined : slackPlugin.actions?.readAuthorityActions,
      },
    },
  });
  setActivePluginRegistry(owner.registry);
  const cfg: ChannelMessageActionContext["cfg"] = {
    channels: {
      slack: {
        enabled: true,
        defaultAccount: "ops",
        accounts: {
          ops: { botToken: "xoxb-synthetic-ops", userToken: "xoxp-synthetic-ops-reader" },
          other: { botToken: "xoxb-synthetic-other", userToken: "xoxp-synthetic-other-reader" },
        },
      },
    },
  };
  const requests: SlackMetadataHarness["requests"] = [];
  const response: SlackMetadataHarness["response"] = {};
  const emojis = Object.fromEntries(
    Array.from({ length: 105 }, (_, index) => [
      `emoji_${String(index).padStart(3, "0")}`,
      `https://emoji.invalid/${index}.png`,
    ]),
  );
  const server = createServer((request, reply) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const fields = Object.fromEntries(new URLSearchParams(body));
      const path = request.url ?? "/";
      requests.push({ path, fields, authorization: request.headers.authorization });
      response.beforeReply?.();
      const payload = response.error
        ? { ok: false, error: response.error }
        : path === "/api/users.info"
          ? { ok: true, user: { id: fields.user, team_id: fields.team_id } }
          : path === "/api/emoji.list"
            ? { ok: true, emoji: emojis }
            : { ok: false, error: "unexpected_fixture_endpoint" };
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify(payload));
    });
  });
  let run: ReturnType<typeof createOriginatingRun> | undefined;
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback TCP address");
    }
    confineProviderFetch("slack", `http://127.0.0.1:${address.port}`);
    setRuntimeConfigSnapshot(cfg, cfg);
    run = createOriginatingRun("slack", options.claim ? "metadata-claim" : "metadata", {
      accountId: "ops",
      senderId: slackRequester,
      toolContext: { currentChannelId: slackCurrentTarget },
    });
    const tool = run.wrapTool(
      createMessageTool({
        ...run.toolOptions,
        config: cfg,
        getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
        resolveCommandSecretRefsViaGateway: async ({ config }) => ({
          resolvedConfig: config,
          diagnostics: [],
          targetStatesByPath: {},
          hadUnresolvedTargets: false,
        }),
      }),
    );
    await exercise({
      record,
      run,
      tool,
      requests,
      response,
      context: {
        cfg,
        channel: "slack",
        action: "member-info",
        params: {},
        accountId: "ops",
        conversationReadOrigin: "delegated",
        assertDirectAdapterHandoff: run.assert,
        ...run.actionContext,
      },
    });
  } finally {
    run?.dispose();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

function invokeSlackMetadata(
  harness: SlackMetadataHarness,
  action: SlackMetadataAction,
  params: Record<string, unknown> = {},
) {
  const args = { action, channel: "slack", ...params };
  expect(Value.Check(harness.tool.parameters, args)).toBe(true);
  return harness.tool.execute(`metadata-${action}`, args);
}

describe("official Slack metadata read boundary", () => {
  it.each([
    { selection: "default requester", params: {} },
    {
      selection: "explicit requester and normalized account",
      params: { userId: slackRequester, accountId: "OPS" },
    },
  ])("reads the targetless $selection through the message tool", async ({ params }) => {
    await withSlackMetadataHarness(async (harness) => {
      const result = await invokeSlackMetadata(harness, "member-info", params);
      expect(result).toMatchObject({
        details: {
          ok: true,
          info: { user: { id: slackRequester, team_id: slackWorkspace } },
        },
      });
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]).toMatchObject({
        path: "/api/users.info",
        fields: { user: slackRequester, team_id: slackWorkspace },
        authorization: "Bearer xoxp-synthetic-ops-reader",
      });
    });
  });

  it.each([
    { limit: undefined, count: 100 },
    { limit: 2, count: 2 },
    { limit: 150, count: 100 },
  ])("bounds targetless workspace emojis for limit $limit", async ({ limit, count }) => {
    await withSlackMetadataHarness(async (harness) => {
      const result = await invokeSlackMetadata(harness, "emoji-list", {
        ...(limit === undefined ? {} : { limit }),
        teamId: "T9999999999",
      });
      expect(result.details).toHaveProperty("emojis.length", count);
      expect(result.details).toMatchObject({
        ok: true,
        emojis: expect.arrayContaining([{ name: "emoji_000", identifier: "emoji_000" }]),
      });
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]).toMatchObject({
        path: "/api/emoji.list",
        fields: { team_id: slackWorkspace },
        authorization: "Bearer xoxp-synthetic-ops-reader",
      });
    });
  });

  it("denies other members and accounts before either metadata request", async () => {
    await withSlackMetadataHarness(async (harness) => {
      await expect(
        invokeSlackMetadata(harness, "member-info", { userId: slackOtherMember }),
      ).rejects.toThrow("limited to the current requester");
      for (const action of slackMetadataActions) {
        await expect(
          invokeSlackMetadata(harness, action, {
            accountId: "other",
            userId: slackRequester,
          }),
        ).rejects.toThrow("Explicit account does not match the trusted current account");
      }
      expect(harness.requests).toEqual([]);
    });
  });

  it("retains both explicit metadata action gates before provider I/O", async () => {
    await withSlackMetadataHarness(async (harness) => {
      const cfg = {
        ...harness.context.cfg,
        channels: {
          ...harness.context.cfg.channels,
          slack: {
            ...harness.context.cfg.channels?.slack,
            actions: { memberInfo: false, emojiList: false },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      for (const [action, error] of [
        ["member-info", "Slack member info is disabled"],
        ["emoji-list", "Slack emoji list is disabled"],
      ] as const) {
        await expect(
          dispatchChannelMessageAction({ ...harness.context, cfg, action, params: {} }),
        ).rejects.toThrow(error);
      }
      expect(harness.requests).toEqual([]);
    });
  });

  it.each(["legacy", "unverified"] as const)(
    "keeps targetless %s adapters restricted",
    async (registration) => {
      await withSlackMetadataHarness(
        async (harness) => {
          for (const action of slackMetadataActions) {
            await expect(invokeSlackMetadata(harness, action)).rejects.toThrow(
              "exact current conversation",
            );
          }
          expect(harness.requests).toEqual([]);
        },
        { registration },
      );
    },
  );

  it.each(["direct", "legacy", "bundled"] as const)(
    "preserves positive %s metadata reads",
    async (entry) => {
      await withSlackMetadataHarness(
        async (harness) => {
          for (const action of slackMetadataActions) {
            const result =
              entry === "bundled"
                ? await invokeSlackMetadata(harness, action)
                : await dispatchChannelMessageAction({
                    ...harness.context,
                    action,
                    params:
                      entry === "direct"
                        ? { userId: slackOtherMember }
                        : { to: slackCurrentTarget },
                    ...(entry === "direct"
                      ? {
                          conversationReadOrigin: "direct-operator" as const,
                          requesterAccountId: undefined,
                          requesterSenderId: undefined,
                          toolContext: undefined,
                          assertDirectAdapterHandoff: undefined,
                        }
                      : {}),
                  });
            expect(result).toMatchObject({ details: { ok: true } });
          }
          expect(harness.requests.map((request) => request.path)).toEqual([
            "/api/users.info",
            "/api/emoji.list",
          ]);
          expect(harness.requests[0]?.fields.user).toBe(
            entry === "direct" ? slackOtherMember : slackRequester,
          );
        },
        { registration: entry === "direct" ? "unverified" : entry },
      );
    },
  );

  it("fences metadata preparation before the SDK can issue a request", async () => {
    await withSlackMetadataHarness(async (harness) => {
      const invocation = dispatchChannelMessageAction(harness.context);
      harness.record.enabled = false;
      await expect(invocation).rejects.toThrow("read authority is no longer active");
      expect(harness.requests).toEqual([]);
    });
  });

  it.each([
    { action: "emoji-list", owner: "plugin", error: false },
    { action: "member-info", owner: "plugin", error: true },
    { action: "emoji-list", owner: "caller", error: false },
  ] as const)(
    "suppresses late $action data after $owner revocation (error=$error)",
    async ({ action, owner, error }) => {
      await withSlackMetadataHarness(
        async (harness) => {
          harness.response.beforeReply = () => {
            if (owner === "plugin") {
              harness.record.enabled = false;
            } else {
              harness.run.revoke();
            }
          };
          if (error) {
            harness.response.error = "sensitive_stale_provider_error";
          }
          await expect(invokeSlackMetadata(harness, action)).rejects.toThrow("no longer active");
          expect(harness.requests).toHaveLength(1);
        },
        { claim: owner === "caller" },
      );
    },
  );
});

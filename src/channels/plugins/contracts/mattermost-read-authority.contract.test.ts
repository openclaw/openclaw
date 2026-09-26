import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../../agents/admitted-run-context.js";
import { wrapToolWithGatewayCallerIdentity } from "../../../agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../../../agents/tools/message-tool-execution.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import type { OpenClawConfig } from "../../../config/types.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../../gateway/message-action-turn-capability.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import { createPluginRegistry } from "../../../plugins/registry.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import type { PluginRuntime } from "../../../plugins/runtime/types.js";
import { createPluginRecord } from "../../../plugins/status.test-fixtures.js";
import { createChannelTestPluginBase } from "../../../test-utils/channel-plugins.js";
import { dispatchChannelMessageAction } from "../message-action-dispatch.js";
import { getBundledChannelPluginAsync } from "./test-helpers/bundled-channel-plugin-loader.js";

const preparation = vi.hoisted(() => ({ afterLookup: undefined as (() => void) | undefined }));
vi.mock("node:dns/promises", async (original) => {
  const actual = await original<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: async (...args: Parameters<typeof actual.lookup>) => {
      const result = await actual.lookup(...args);
      preparation.afterLookup?.();
      return result;
    },
  };
});

const CURRENT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const POST = { id: "post-fixture", message: "permitted history", create_at: 1_700_000_000_000 };
const metadataPath = `/api/v4/channels/${OTHER}`;
const postsPath = (target: string) => `/api/v4/channels/${target}/posts?per_page=1`;

afterEach(() => {
  preparation.afterLookup = undefined;
  vi.unstubAllEnvs();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

type FixtureOptions = {
  origin?: "bundled" | "global";
  legacy?: boolean;
  trusted?: boolean;
  requesterAccountId?: string;
  currentProvider?: string;
  currentChatType?: "channel" | "direct";
  currentMessagingTarget?: string;
  rawTarget?: string;
  configure?: (cfg: OpenClawConfig) => void;
};

async function withReadFixture(
  options: FixtureOptions,
  run: (fixture: {
    read: (target: string) => Promise<unknown>;
    directRead: (target: string) => Promise<unknown>;
    requests: string[];
    revoke: (owner: "plugin" | "run" | "turn") => void;
    beforeResponse: (hook: (path: string) => number | undefined) => void;
  }) => Promise<void>,
) {
  const mattermostPlugin = await getBundledChannelPluginAsync("mattermost");
  const actions = mattermostPlugin?.actions;
  if (!mattermostPlugin || !actions) {
    throw new Error("Mattermost message actions are unavailable");
  }
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  // Installer/loader provenance is covered separately; this fixture exercises
  // the real registered Mattermost adapter, message tool, and HTTP transport.
  const record = createPluginRecord({
    id: "mattermost",
    origin: options.origin ?? "global",
    trustedOfficialInstall: options.trusted ?? true,
  });
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({
    plugin: {
      ...mattermostPlugin,
      status: undefined,
      actions: {
        ...actions,
        readAuthorityActions: options.legacy ? undefined : actions.readAuthorityActions,
      },
    },
  });
  if (options.currentProvider === "slack") {
    // The requester needs discovery metadata, not the bundled Slack runtime.
    const requester = createPluginRecord({
      id: "slack",
      origin: "config",
      trustedOfficialInstall: false,
    });
    owner.registry.plugins.push(requester);
    owner.createApi(requester, { config: {}, registrationMode: "full" }).registerChannel({
      plugin: {
        ...createChannelTestPluginBase({ id: "slack" }),
        actions: { describeMessageTool: () => ({ actions: [] }) },
      },
    });
  }
  setActivePluginRegistry(owner.registry);
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
  const requests: string[] = [];
  let beforeResponse: ((path: string) => number | undefined) | undefined;
  await withServer(
    (request, response) => {
      const path = request.url ?? "";
      requests.push(path);
      request.resume();
      const status = beforeResponse?.(path) ?? 200;
      response.writeHead(status, { "content-type": "application/json" });
      if (status !== 200) {
        response.end(JSON.stringify({ message: "provider denied history" }));
      } else if (path === "/api/v4/users/me") {
        response.end(JSON.stringify({ id: "fixture-bot" }));
      } else if (path === "/api/v4/users/fixture-bot/channels?per_page=200") {
        response.end(JSON.stringify([{ id: OTHER, name: "allowed", type: "O" }]));
      } else if (path === metadataPath) {
        response.end(JSON.stringify({ id: OTHER, type: "O" }));
      } else if (path === postsPath(CURRENT) || path === postsPath(OTHER)) {
        response.end(JSON.stringify({ order: [POST.id], posts: { [POST.id]: POST } }));
      } else {
        response.end(JSON.stringify({ message: `Unexpected fixture request: ${path}` }));
      }
    },
    async (baseUrl) => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "synthetic-mattermost-fixture",
            baseUrl,
            network: { dangerouslyAllowPrivateNetwork: true },
            actions: { messages: true },
            groupPolicy: "allowlist",
            groups: { [OTHER]: {} },
            accounts: { other: { enabled: true } },
          },
        },
      };
      options.configure?.(cfg);
      setRuntimeConfigSnapshot(cfg, cfg);
      const requesterAccountId = options.requesterAccountId ?? "default";
      const toolContext = {
        currentChannelProvider: options.currentProvider ?? "mattermost",
        currentChannelId: `channel:${CURRENT}`,
        currentChatType: options.currentChatType ?? ("channel" as const),
        ...(options.currentMessagingTarget
          ? { currentMessagingTarget: options.currentMessagingTarget }
          : {}),
      };
      const sessionKey = `agent:main:mattermost:channel:${CURRENT}`;
      const operationalRunInstance = createOperationalRunInstanceRef("mattermost-read-fixture");
      const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const turnCapability = mintMessageActionTurnCapability({
        agentId: "main",
        runId: operationalRunInstance.runId,
        sessionKey,
        requesterAccountId,
        requesterSenderId: "synthetic-requester",
        toolContext,
      });
      const tool = wrapToolWithGatewayCallerIdentity(
        createMessageTool({
          config: cfg,
          agentId: "main",
          agentAccountId: requesterAccountId,
          agentSessionKey: sessionKey,
          runId: operationalRunInstance.runId,
          messageActionTurnCapability: turnCapability,
          ...toolContext,
          getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
          resolveCommandSecretRefsViaGateway: async ({ config }) => ({
            resolvedConfig: config,
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
      );
      try {
        await run({
          requests,
          read: (target) =>
            tool.execute("mattermost-read", {
              action: "read",
              channel: "mattermost",
              accountId: "default",
              target: options.rawTarget ?? `channel:${target}`,
              limit: 1,
            }),
          directRead: (target) =>
            dispatchChannelMessageAction({
              action: "read",
              channel: "mattermost",
              accountId: "default",
              cfg,
              params: { target: `channel:${target}`, limit: 1 },
              conversationReadOrigin: "direct-operator",
            }),
          revoke: (authorityOwner) => {
            if (authorityOwner === "plugin") {
              record.enabled = false;
            } else if (authorityOwner === "run") {
              releaseAgentRunDelegatedAuthority(delegatedAuthority);
            } else {
              revokeMessageActionTurnCapability(turnCapability);
            }
          },
          beforeResponse: (hook) => {
            beforeResponse = hook;
          },
        });
      } finally {
        revokeMessageActionTurnCapability(turnCapability);
        releaseAgentRunDelegatedAuthority(delegatedAuthority);
      }
    },
  );
}

describe("Mattermost registered message reads", () => {
  it("reads the current DM by its native channel while sends target its user", async () => {
    await withReadFixture(
      { currentChatType: "direct", currentMessagingTarget: "user:cccccccccccccccccccccccccc" },
      async ({ read, requests }) => {
        await expect(read(CURRENT)).resolves.toMatchObject({
          details: { ok: true, channelId: CURRENT, messages: [{ id: POST.id }] },
        });
        expect(requests).toEqual([postsPath(CURRENT)]);
      },
    );
  });

  it.each([false, true])(
    "retains caller authority through directory resolution (revoke=%s)",
    async (revokeDuringResolution) => {
      await withReadFixture(
        { rawTarget: "#allowed" },
        async ({ read, requests, revoke, beforeResponse }) => {
          if (revokeDuringResolution) {
            beforeResponse((path) => {
              if (path === "/api/v4/users/me") {
                revoke("run");
              }
              return undefined;
            });
            await expect(read(OTHER)).rejects.toThrow(/no longer active/);
            expect(requests).toEqual(["/api/v4/users/me"]);
          } else {
            await expect(read(OTHER)).resolves.toMatchObject({
              details: { ok: true, channelId: OTHER },
            });
            expect(requests).toEqual([
              "/api/v4/users/me",
              "/api/v4/users/fixture-bot/channels?per_page=200",
              metadataPath,
              postsPath(OTHER),
            ]);
          }
        },
      );
    },
  );

  it.each(["bundled", "global"] as const)(
    "reads current and configured channels with %s registration",
    async (origin) => {
      await withReadFixture({ origin }, async ({ read, requests }) => {
        for (const target of [CURRENT, OTHER]) {
          await expect(read(target)).resolves.toMatchObject({
            details: {
              ok: true,
              channelId: target,
              messages: [
                {
                  ...POST,
                  timestampMs: 1_700_000_000_000,
                  timestampUtc: "2023-11-14T22:13:20.000Z",
                },
              ],
              hasMore: false,
            },
          });
        }
        expect(requests).toEqual([postsPath(CURRENT), metadataPath, postsPath(OTHER)]);
      });
    },
  );

  it.each([
    {
      name: "disabled by default",
      configure: (cfg: OpenClawConfig) => {
        delete cfg.channels!.mattermost!.actions;
      },
      error: "reads are disabled",
    },
    {
      name: "disabled for the selected account",
      configure: (cfg: OpenClawConfig) => {
        cfg.channels!.mattermost!.accounts = { default: { actions: { messages: false } } };
      },
      error: "reads are disabled",
    },
    {
      name: "another requester account",
      requesterAccountId: "other",
      error: "Explicit account does not match the trusted current account.",
    },
    {
      name: "another requester provider",
      currentProvider: "slack",
      error: /current provider and account|Cross-context/,
    },
  ])("rejects $name before provider access", async ({ name: _name, error, ...options }) => {
    await withReadFixture(options, async ({ read, requests }) => {
      await expect(read(OTHER)).rejects.toThrow(error);
      expect(requests).toEqual([]);
    });
  });

  it("preserves provider channel policy before reading posts", async () => {
    await withReadFixture(
      {
        configure: (cfg) => {
          cfg.channels!.mattermost!.groups = {};
        },
      },
      async ({ read, requests }) => {
        await expect(read(OTHER)).rejects.toThrow("Mattermost read target channel is not allowed");
        expect(requests).toEqual([metadataPath]);
      },
    );
  });

  it.each(["plugin", "run", "turn"] as const)(
    "stops after metadata when %s authority is revoked",
    async (authorityOwner) => {
      await withReadFixture({}, async ({ read, requests, revoke, beforeResponse }) => {
        beforeResponse((path) => {
          if (path === metadataPath) {
            revoke(authorityOwner);
          }
          return undefined;
        });
        await expect(read(OTHER)).rejects.toThrow(/no longer active/);
        expect(requests).toEqual([metadataPath]);
      });
    },
  );

  it.each(["bundled", "global"] as const)(
    "checks %s read authority after DNS preparation before each request",
    async (origin) => {
      for (const beforePosts of [false, true]) {
        await withReadFixture({ origin }, async ({ read, requests, revoke }) => {
          let lookups = 0;
          preparation.afterLookup = () => {
            lookups += 1;
            if (!beforePosts || requests.includes(metadataPath)) {
              revoke("plugin");
            }
          };
          await expect(read(OTHER)).rejects.toThrow(/no longer active/);
          expect(lookups).toBeGreaterThan(0);
          expect(requests).toEqual(beforePosts ? [metadataPath] : []);
          preparation.afterLookup = undefined;
        });
      }
    },
  );

  it.each([
    { owner: "plugin" as const, status: 200 },
    { owner: "plugin" as const, status: 403 },
    { owner: "run" as const, status: 200 },
    { owner: "run" as const, status: 403 },
  ])("fences late $status responses after $owner revocation", async ({ owner, status }) => {
    await withReadFixture({}, async ({ read, requests, revoke, beforeResponse }) => {
      beforeResponse((path) => {
        if (path === postsPath(OTHER)) {
          revoke(owner);
          return status;
        }
        return undefined;
      });
      await expect(read(OTHER)).rejects.toThrow(/no longer active/);
      expect(requests).toEqual([metadataPath, postsPath(OTHER)]);
    });
  });

  it.each([{ legacy: true }, { trusted: false }])(
    "preserves exact-current restrictions without installed read authority (%j)",
    async (options) => {
      await withReadFixture(options, async ({ read, requests }) => {
        await expect(read(CURRENT)).resolves.toMatchObject({ details: { ok: true } });
        await expect(read(OTHER)).rejects.toThrow("exact current conversation");
        expect(requests).toEqual([postsPath(CURRENT)]);
      });
    },
  );

  it("preserves direct operator reads and provider errors", async () => {
    await withReadFixture(
      {
        configure: (cfg) => {
          cfg.channels!.mattermost!.groups = {};
        },
      },
      async ({ directRead, requests, beforeResponse }) => {
        await expect(directRead(OTHER)).resolves.toMatchObject({ details: { ok: true } });
        beforeResponse(() => 403);
        await expect(directRead(OTHER)).rejects.toThrow(
          "Mattermost API 403 Forbidden: provider denied history",
        );
        expect(requests).toEqual([postsPath(OTHER), postsPath(OTHER)]);
      },
    );
  });
});

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
import { createTestPluginRegistry } from "../../../plugins/registry-runtime.test-helpers.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { createPluginRecord } from "../../../plugins/status.test-fixtures.js";
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
const posts = { order: [POST.id], posts: { [POST.id]: POST } };
const routes: Record<string, unknown> = {
  "/api/v4/users/me": { id: "fixture-bot" },
  "/api/v4/users/fixture-bot/channels?per_page=200": [{ id: OTHER, name: "allowed", type: "O" }],
  [metadataPath]: { id: OTHER, type: "O" },
  [postsPath(CURRENT)]: posts,
  [postsPath(OTHER)]: posts,
};
const readAction = { action: "read", channel: "mattermost", accountId: "default" } as const;

afterEach(() => {
  preparation.afterLookup = undefined;
  vi.unstubAllEnvs();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

type FixtureOptions = {
  origin?: "bundled" | "global";
  currentChatType?: "channel" | "direct";
  currentMessagingTarget?: string;
  rawTarget?: string;
  allowOtherChannel?: boolean;
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
  if (!mattermostPlugin?.actions) {
    throw new Error("Mattermost message actions are unavailable");
  }
  const owner = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "mattermost",
    origin: options.origin ?? "global",
    trustedOfficialInstall: true,
  });
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({
    plugin: {
      ...mattermostPlugin,
      status: undefined,
    },
  });
  setActivePluginRegistry(owner.registry);
  for (const key of "HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy".split(
    " ",
  )) {
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
      const body =
        status !== 200
          ? { message: "provider denied history" }
          : (routes[path] ?? { message: `Unexpected fixture request: ${path}` });
      response.end(JSON.stringify(body));
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
            groups: options.allowOtherChannel === false ? {} : { [OTHER]: {} },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      const requesterAccountId = "default";
      const toolContext = {
        currentChannelProvider: "mattermost",
        currentChannelId: `channel:${CURRENT}`,
        currentChatType: options.currentChatType ?? ("channel" as const),
        ...(options.currentMessagingTarget
          ? { currentMessagingTarget: options.currentMessagingTarget }
          : {}),
      };
      const sessionKey = `agent:main:mattermost:channel:${CURRENT}`;
      const operationalRunInstance = createOperationalRunInstanceRef("mattermost-read-fixture");
      const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const identity = { agentId: "main", runId: operationalRunInstance.runId, sessionKey };
      const turnCapability = mintMessageActionTurnCapability({
        ...identity,
        requesterAccountId,
        requesterSenderId: "synthetic-requester",
        toolContext,
      });
      const tool = wrapToolWithGatewayCallerIdentity(
        createMessageTool({
          ...identity,
          config: cfg,
          agentAccountId: requesterAccountId,
          agentSessionKey: sessionKey,
          messageActionTurnCapability: turnCapability,
          ...toolContext,
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
              ...readAction,
              target: options.rawTarget ?? `channel:${target}`,
              limit: 1,
            }),
          directRead: (target) =>
            dispatchChannelMessageAction({
              ...readAction,
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

type AuthorityOwner = "plugin" | "run" | "turn";
type Revocation = [AuthorityOwner, string, number?];
async function checkRead(
  options: FixtureOptions,
  target: string,
  expected: object | string | RegExp,
  paths: string[],
  revocation?: Revocation,
) {
  await withReadFixture(options, async ({ read, requests, revoke, beforeResponse }) => {
    if (revocation) {
      const [owner, at, status] = revocation;
      beforeResponse((path) => {
        if (path !== at) {
          return undefined;
        }
        revoke(owner);
        return status;
      });
    }
    const result = read(target);
    if (typeof expected === "string" || expected instanceof RegExp) {
      await expect(result).rejects.toThrow(expected);
    } else {
      await expect(result).resolves.toMatchObject({ details: expected });
    }
    expect(requests).toEqual(paths);
  });
}

describe("Mattermost registered message reads", () => {
  it("reads current DM history by channel, not the messaging user", () =>
    checkRead(
      { currentChatType: "direct", currentMessagingTarget: "user:cccccccccccccccccccccccccc" },
      CURRENT,
      { ok: true, channelId: CURRENT, messages: [{ id: POST.id }] },
      [postsPath(CURRENT)],
    ));

  it.each([false, true])("directory resolution retains authority (revoked=%s)", (revoked) =>
    checkRead(
      { rawTarget: "#allowed" },
      OTHER,
      revoked
        ? /no longer active/
        : {
            ok: true,
            channelId: OTHER,
            hasMore: false,
            messages: [
              { ...POST, timestampMs: 1_700_000_000_000, timestampUtc: "2023-11-14T22:13:20.000Z" },
            ],
          },
      revoked
        ? ["/api/v4/users/me"]
        : [
            "/api/v4/users/me",
            "/api/v4/users/fixture-bot/channels?per_page=200",
            metadataPath,
            postsPath(OTHER),
          ],
      revoked ? ["run", "/api/v4/users/me"] : undefined,
    ),
  );

  it("rejects channels outside the allowlist", () =>
    checkRead(
      { allowOtherChannel: false },
      OTHER,
      "Mattermost read target channel is not allowed",
      [metadataPath],
    ));

  it.each<Revocation>([
    ["turn", metadataPath],
    ["plugin", postsPath(OTHER), 200],
    ["run", postsPath(OTHER), 403],
  ])("fences %s revocation at %s (status=%s)", (owner, at, status?: number) =>
    checkRead(
      {},
      OTHER,
      /no longer active/,
      at === metadataPath ? [metadataPath] : [metadataPath, postsPath(OTHER)],
      [owner, at, status],
    ),
  );

  it("checks bundled read authority after DNS preparation before each request", async () => {
    for (const beforePosts of [false, true]) {
      await withReadFixture({ origin: "bundled" }, async ({ read, requests, revoke }) => {
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
  });

  it("preserves direct operator reads and provider errors", async () => {
    await withReadFixture(
      { allowOtherChannel: false },
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

import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { UsersChannelIdentityResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import * as bundledChannels from "../../channels/plugins/bundled.js";
import { getLoadedChannelPlugin } from "../../channels/plugins/registry.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  changeCanonicalUserChannelIdentity,
  listCanonicalUserChannelIdentities,
} from "../../state/user-channel-identity-operations.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { handleProviderOAuthCallback } from "../provider-browser-auth.js";
import { createRequest, createResponse } from "../server-http.test-harness.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

let state: OpenClawTestState;
let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>>;
let clients: Set<GatewayClient>;
let alice: GatewayClient;
let bob: GatewayClient;
let context: GatewayRequestContext;
let config: OpenClawConfig;
let providerCurrent: boolean;
const exchange = vi.fn(async () => ({ senderId: "123456789012345678" }));
const nonce = "11111111-1111-4111-8111-111111111111";
const cookie = "openclaw-channel-link-" + nonce + "=" + nonce;
const owner = (client: GatewayClient) => client.authenticatedUserProfile!.profileId;
async function rpc(
  client: GatewayClient,
  params: Record<string, unknown>,
  method = "users.channelIdentity",
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "test", method, params },
    client,
    context,
    respond,
    isWebchatConnect: () => false,
  });
  return respond.mock.calls[0]!;
}
async function start(client = alice) {
  const reply = await rpc(client, {
    action: "start",
    channelId: "discord",
    accountId: "default",
    browserNonce: nonce,
  });
  expect(reply[0]).toBe(true);
  return reply[1] as UsersChannelIdentityResult;
}
function callback(flow: UsersChannelIdentityResult, cookies?: string) {
  const url = new URL(flow.authorizationUrl!);
  const res = createResponse();
  handleProviderOAuthCallback(
    createRequest({
      path: "/oauth/provider/callback?state=" + url.searchParams.get("state") + "&code=test-code",
      method: "GET",
      headers: cookies ? { cookie: cookies } : {},
    }),
    res.res,
  );
  return res.res.statusCode;
}
async function terminal(flow: UsersChannelIdentityResult, client = alice) {
  let result: UsersChannelIdentityResult | undefined;
  await vi.waitFor(async () => {
    const reply = await rpc(client, {
      action: "poll",
      channelId: "discord",
      accountId: "default",
      requestId: flow.requestId,
    });
    expect(reply[0]).toBe(true);
    result = reply[1];
    expect(result?.status).not.toBe("pending");
  });
  return result!;
}
beforeEach(async () => {
  resetGatewayWorkAdmission();
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  config = {};
  setRuntimeConfigSnapshot(config);
  clients = new Set();
  const user = (email: string): GatewayClient => {
    const profile = ensureProfileForEmail(email);
    const client: GatewayClient = {
      connId: profile.id,
      authenticatedUserId: email,
      authenticatedUserProfile: gatewayProfile(profile.id),
      connect: gatewayConnect(["operator.sessions.write"]),
      browserOrigin: {
        origin: "https://gateway.example",
        requestHost: "gateway.example",
        isLocalClient: false,
      },
    };
    clients.add(client);
    return client;
  };
  alice = user("alice@example.test");
  bob = user("bob@example.test");
  catalog = await prepareUserProfileCatalog();
  providerCurrent = true;
  exchange.mockReset().mockResolvedValue({ senderId: "123456789012345678" });
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "discord" }),
    identityLink: {
      prepare: async (_cfg, accountId) =>
        accountId === "default"
          ? {
              isCurrent: () => providerCurrent,
              authorizationUrl: ({ state: id, redirectUri }) =>
                "https://discord.example/authorize?" +
                new URLSearchParams({ state: id, redirect_uri: redirectUri }).toString(),
              exchange,
            }
          : undefined,
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));
  context = {
    getRuntimeConfig: () => config,
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(
        [...clients].filter((client) => !filter || filter(client)).map((client) => client.connId),
      ),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
});
afterEach(async () => {
  markGatewayRestartDraining();
  await Promise.resolve();
  catalog.release();
  await state.cleanup();
  clearRuntimeConfigSnapshot();
  resetGatewayWorkAdmission();
  vi.unstubAllEnvs();
});

it("reports and disconnects saved identities without loading an unconfigured channel", async () => {
  setActivePluginRegistry(createTestRegistry([]));
  const load = vi.spyOn(bundledChannels, "getBundledChannelPlugin").mockImplementation(() => {
    throw new Error("Unconfigured channel runtime must remain unloaded");
  });
  onTestFinished(() => load.mockRestore());
  const status = () => rpc(alice, { action: "status", channelId: "discord" });
  expect((await status()).slice(0, 2)).toEqual([true, { status: "ready", accounts: [] }]);
  await changeCanonicalUserChannelIdentity("link", owner(alice), {
    channelId: "discord",
    accountId: "default",
    senderId: "123456789012345678",
  });
  expect((await status()).slice(0, 2)).toEqual([
    true,
    {
      status: "ready",
      accounts: [{ accountId: "default", available: false, senderIds: ["123456789012345678"] }],
    },
  ]);
  expect(
    (await rpc(alice, { action: "disconnect", channelId: "discord", accountId: "default" }))[0],
  ).toBe(true);
  expect(await listCanonicalUserChannelIdentities(owner(alice))).toEqual([]);
  expect(load).not.toHaveBeenCalled();
});

it("allows a configured bundled adapter to link before its channel runtime is registered", async () => {
  const plugin = getLoadedChannelPlugin("discord")!;
  setActivePluginRegistry(createTestRegistry([]));
  config = { channels: { discord: {} } };
  setRuntimeConfigSnapshot(config);
  const load = vi.spyOn(bundledChannels, "getBundledChannelPlugin").mockReturnValue(plugin);
  onTestFinished(() => load.mockRestore());
  expect((await rpc(alice, { action: "status", channelId: "discord" }))[1]).toMatchObject({
    accounts: [{ accountId: "default", available: true }],
  });
  const flow = await start();
  expect(callback(flow, cookie)).toBe(200);
  expect((await terminal(flow)).status).toBe("linked");
  expect(await listCanonicalUserChannelIdentities(owner(alice))).toHaveLength(1);
});

it("links through the real Discord adapter, rejects replay and conflicts, and disconnects through the canonical store", async () => {
  const requests: string[] = [];
  let userResponse = Promise.withResolvers<void>();
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const body =
      req.method === "POST" && req.url === "/api/v10/oauth2/token"
        ? { access_token: "fixture-token" }
        : req.method === "GET" && req.url === "/api/v10/users/@me"
          ? { id: "123456789012345678" }
          : undefined;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}), () => {
      if (req.method === "GET" && req.url === "/api/v10/users/@me") {
        userResponse.resolve();
      }
    });
  });
  onTestFinished(() => server[Symbol.asyncDispose]());
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a loopback HTTP address");
  }
  vi.stubEnv("DISCORD_API_URL", `http://127.0.0.1:${address.port}/api/v10`);
  config = {
    channels: {
      discord: {
        activities: { applicationId: "123456789012345678", clientSecret: "fixture-secret" },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
    pluginId: "discord",
    artifactBasename: "api.js",
  });
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
  );
  const flow = await start();
  expect(new URL(flow.authorizationUrl!).searchParams.get("redirect_uri")).toBe(
    "https://gateway.example/oauth/provider/callback",
  );
  expect(callback(flow)).toBe(403);
  expect(requests).toEqual([]);
  expect(callback(flow, cookie)).toBe(200);
  expect(callback(flow, cookie)).toBe(410);
  await userResponse.promise;
  expect((await terminal(flow)).status).toBe("linked");
  expect(requests).toEqual(["POST /api/v10/oauth2/token", "GET /api/v10/users/@me"]);
  expect(await listCanonicalUserChannelIdentities(owner(alice))).toEqual([
    {
      profileId: owner(alice),
      identity: { channelId: "discord", accountId: "default", senderId: "123456789012345678" },
    },
  ]);
  expect(await listCanonicalUserChannelIdentities(owner(bob))).toEqual([]);
  userResponse = Promise.withResolvers<void>();
  const other = await start(bob);
  expect(callback(other, cookie)).toBe(200);
  await userResponse.promise;
  expect(await terminal(other, bob)).toMatchObject({
    status: "failed",
    message: expect.stringContaining("another profile"),
  });
  expect(
    (
      await rpc(bob, {
        action: "poll",
        channelId: "discord",
        accountId: "default",
        requestId: flow.requestId,
      })
    )[0],
  ).toBe(false);
  expect(
    (await rpc(alice, { action: "disconnect", channelId: "discord", accountId: "default" }))[0],
  ).toBe(true);
  expect(await listCanonicalUserChannelIdentities(owner(alice))).toEqual([]);
});

it.each(["connection", "scope", "provider", "cancel"])(
  "does not commit after %s revocation",
  async (change) => {
    const flow = await start();
    const observer = {
      ...alice,
      connId: "observer",
      connect: gatewayConnect(["operator.sessions.write"]),
    };
    clients.add(observer);
    if (change === "connection") {
      clients.delete(alice);
    }
    if (change === "scope") {
      alice.connect.scopes = [];
    }
    if (change === "provider") {
      providerCurrent = false;
    }
    if (change === "cancel") {
      await rpc(alice, {
        action: "cancel",
        channelId: "discord",
        accountId: "default",
        requestId: flow.requestId,
      });
    }
    const response = callback(flow, cookie);
    if (change === "cancel") {
      expect(response).toBe(410);
    } else {
      expect((await terminal(flow, observer)).status).toBe("failed");
    }
    expect(exchange).not.toHaveBeenCalled();
    expect(await listCanonicalUserChannelIdentities(owner(alice))).toEqual([]);
  },
);

it("rechecks live authority after exchanging proof and before storing the link", async () => {
  let finish!: (identity: { senderId: string }) => void;
  exchange.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const observer = {
    ...alice,
    connId: "observer",
    connect: gatewayConnect(["operator.sessions.write"]),
  };
  clients.add(observer);
  const flow = await start();
  expect(callback(flow, cookie)).toBe(200);
  await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
  clients.delete(alice);
  finish({ senderId: "123456789012345678" });
  expect((await terminal(flow, observer)).status).toBe("failed");
  expect(await listCanonicalUserChannelIdentities(owner(alice))).toEqual([]);
});

it("keeps administrative attestation privileged and rejects claimed profile IDs and unknown accounts", async () => {
  const denied = await rpc(
    alice,
    {
      profileId: owner(bob),
      identity: { channelId: "discord", accountId: "default", senderId: "123456789012345678" },
    },
    "users.linkChannelIdentity",
  );
  expect(denied[0]).toBe(false);
  expect(denied[2]).toMatchObject({ message: "missing scope: operator.admin" });
  expect(await listCanonicalUserChannelIdentities(owner(bob))).toEqual([]);
  for (const extra of [{ profileId: owner(bob) }, { accountId: "unknown" }]) {
    expect(
      (
        await rpc(alice, {
          action: "start",
          channelId: "discord",
          accountId: "default",
          browserNonce: nonce,
          ...extra,
        })
      )[0],
    ).toBe(false);
  }
});

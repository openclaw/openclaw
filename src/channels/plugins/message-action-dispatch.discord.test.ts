import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../../../extensions/discord/channel-plugin-api.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { revokePluginRecordLifecycleEpoch } from "../../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type { ChannelMessageActionContext } from "./types.js";

const channelId = "123456789012345678";
const currentChannelId = "223456789012345678";
const guildId = "323456789012345678";
const token = "synthetic-dispatch-authority-token";
const channelPath = `/channels/${channelId}`;
const messagesPath = `${channelPath}/messages`;
const channel = { id: channelId, type: 0, guild_id: guildId, name: "synthetic-target" };
const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestPath(input: Parameters<typeof fetch>[0]) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://discord.com" || !url.pathname.startsWith("/api/v10/")) {
    throw new Error(`Unexpected fixture URL: ${url.origin}${url.pathname}`);
  }
  return url.pathname.slice("/api/v10".length);
}

function responseFor(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  expect(init?.method).toBe("GET");
  expect(new Headers(init?.headers).get("Authorization")).toBe(`Bot ${token}`);
  switch (requestPath(input)) {
    case channelPath:
      return jsonResponse(channel);
    case messagesPath:
      return jsonResponse([
        { id: "423456789012345678", channel_id: channelId, content: "fixture" },
      ]);
    default:
      throw new Error(`Unexpected fixture request: ${requestPath(input)}`);
  }
}

function registerDiscord() {
  // This is registered-adapter composition proof, not installed-package provenance proof.
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "discord",
    origin: "global",
    trustedOfficialInstall: true,
  });
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({
    plugin: discordPlugin,
  });
  setActivePluginRegistry(owner.registry);
  return () => revokePluginRecordLifecycleEpoch(owner.registry, record);
}

function invoke(
  options: {
    allowed?: boolean;
    currentChannel?: string;
    requesterAccountId?: string;
  } = {},
) {
  const cfg: OpenClawConfig = {
    channels: {
      discord: {
        token,
        groupPolicy: "allowlist",
        guilds: {
          [guildId]: {
            channels: {
              [options.allowed === false ? currentChannelId : channelId]: { enabled: true },
            },
          },
        },
      },
    },
  };
  const context: ChannelMessageActionContext = {
    channel: "discord",
    action: "read",
    cfg,
    params: { channelId, limit: 1 },
    accountId: "default",
    requesterAccountId: options.requesterAccountId ?? "default",
    conversationReadOrigin: "delegated",
    toolContext: {
      currentChannelProvider: "discord",
      currentChannelId: options.currentChannel ?? currentChannelId,
    },
  };
  return dispatchChannelMessageAction(context);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => responseFor(input, init));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("registered official Discord read authority through HTTP", () => {
  it("allows configured cross-conversation reads through the real adapter", async () => {
    registerDiscord();
    await expect(invoke()).resolves.toMatchObject({ details: { ok: true } });
    expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).toEqual([
      channelPath,
      messagesPath,
    ]);
  });

  it.each([
    { name: "unconfigured target", allowed: false },
    {
      name: "current target visibility from another account",
      allowed: false,
      currentChannel: channelId,
      requesterAccountId: "other",
    },
  ])("denies $name before reading message content", async (options) => {
    registerDiscord();
    await expect(invoke(options)).rejects.toThrow("Discord read target channel is not allowed");
    expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).toEqual([channelPath]);
  });

  it("stops the next provider request when the registrar revokes during metadata lookup", async () => {
    const revoke = registerDiscord();
    const started = createDeferred<void>();
    const response = createDeferred<Response>();
    fetchMock.mockImplementationOnce(async () => {
      started.resolve();
      return await response.promise;
    });
    const outcome = Promise.allSettled([invoke()]);
    await started.promise;
    revoke();
    response.resolve(jsonResponse(channel));
    const [result] = await outcome;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(String(result.reason)).toContain("read authority is no longer active");
    }
    expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).toEqual([channelPath]);
  });

  it.each([false, true])(
    "checks registrar authority on provider retry (revoked=%s)",
    async (revoked) => {
      vi.useFakeTimers();
      const revoke = registerDiscord();
      const limited = createDeferred<void>();
      let attempts = 0;
      fetchMock.mockImplementation(async (input, init) => {
        if (requestPath(input) === messagesPath && ++attempts === 1) {
          limited.resolve();
          return jsonResponse({ message: "Rate limited", retry_after: 1, global: false }, 429);
        }
        return responseFor(input, init);
      });
      const outcome = Promise.allSettled([invoke()]);
      await limited.promise;
      await vi.advanceTimersByTimeAsync(0);
      if (revoked) {
        revoke();
      }
      await vi.advanceTimersByTimeAsync(1000);
      const [result] = await outcome;
      expect(result.status).toBe(revoked ? "rejected" : "fulfilled");
      if (revoked && result.status === "rejected") {
        expect(String(result.reason)).toContain("read authority is no longer active");
      }
      expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).toEqual(
        revoked ? [channelPath, messagesPath] : [channelPath, messagesPath, messagesPath],
      );
    },
  );
});

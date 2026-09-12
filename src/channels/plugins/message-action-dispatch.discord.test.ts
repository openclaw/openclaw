import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { resetDirectoryCache } from "../../infra/outbound/target-resolver.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { revokePluginRecord } from "../../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "./types.js";

const { discordPlugin } = loadBundledPluginPublicArtifactModuleSync<{
  discordPlugin: ChannelPlugin;
}>({
  dirName: "discord",
  artifactBasename: "channel-plugin-api.js",
});

const channelId = "123456789012345678";
const currentChannelId = "223456789012345678";
const guildId = "323456789012345678";
const token = "synthetic-dispatch-authority-token";
const channelPath = `/channels/${channelId}`;
const messagesPath = `${channelPath}/messages`;
const channel = { id: channelId, type: 0, guild_id: guildId, name: "synthetic-target" };
const fetchMock = vi.fn<typeof fetch>();
const instances = new Set<PluginInstance>();

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

function registerDiscord(v2Only = false) {
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
  const instance = new PluginInstance(record.id, { record, registry: owner.registry });
  instances.add(instance);
  instance.run(() => {
    owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({
      plugin: v2Only
        ? { ...discordPlugin, actions: { ...discordPlugin.actions, handleAction: undefined } }
        : discordPlugin,
    });
  });
  setActivePluginRegistry(owner.registry);
  return { registry: owner.registry, revoke: () => revokePluginRecord(owner.registry, record) };
}

function invoke(
  options: {
    allowed?: boolean;
    currentChannel?: string;
    requesterAccountId?: string;
    runner?: boolean;
    target?: string;
    dryRun?: boolean;
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
    params: { channelId: options.target ?? channelId, limit: 1 },
    accountId: "default",
    dryRun: options.dryRun,
    requesterAccountId: options.requesterAccountId ?? "default",
    conversationReadOrigin: "delegated",
    toolContext: {
      currentChannelProvider: "discord",
      currentChannelId: options.currentChannel ?? currentChannelId,
    },
  };
  return options.runner
    ? runMessageAction({ ...context, params: { ...context.params, channel: "discord" } })
    : dispatchChannelMessageAction(context);
}

beforeEach(() => {
  resetDirectoryCache();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => responseFor(input, init));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  resetPluginRuntimeStateForTest();
  try {
    await Promise.all([...instances].map((instance) => instance.dispose()));
  } finally {
    instances.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

describe("registered official Discord read authority through HTTP", () => {
  it("runs a V2-only adapter through the real message-tool runner", async () => {
    registerDiscord(true);
    await expect(invoke({ runner: true })).resolves.toMatchObject({ kind: "action" });
    expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).toEqual([
      channelPath,
      messagesPath,
    ]);
  });

  it("keeps official dry runs network-free without claiming name validation", async () => {
    registerDiscord();
    await expect(
      invoke({ runner: true, target: "unverified-name", dryRun: true }),
    ).resolves.toMatchObject({ handledBy: "dry-run", dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a named target inside the real runner's fenced provider path", async () => {
    registerDiscord();
    fetchMock.mockImplementation(async (input, init) => {
      const path = requestPath(input);
      if (path === "/users/@me/guilds") return jsonResponse([{ id: guildId, name: "fixture" }]);
      if (path === `/guilds/${guildId}/channels`) return jsonResponse([channel]);
      return responseFor(input, init);
    });
    await expect(invoke({ runner: true, target: "synthetic-target" })).resolves.toMatchObject({
      kind: "action",
    });
    expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).toContain(messagesPath);
  });

  it("stops directory continuation after revocation during named-target lookup", async () => {
    const { revoke } = registerDiscord();
    const started = createDeferred();
    const release = createDeferred();
    fetchMock.mockImplementation(async (input) => {
      expect(requestPath(input)).toBe("/users/@me/guilds");
      started.resolve();
      await release.promise;
      return jsonResponse([{ id: guildId, name: "fixture" }]);
    });
    const pending = invoke({ runner: true, target: "synthetic-target" });
    const result = Promise.allSettled([pending]);
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("Expected directory lookup");
      }),
    ]);
    revoke();
    release.resolve();
    expect((await result)[0]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

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
    const { revoke } = registerDiscord();
    const started = createDeferred();
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

  it("rejects an old read across adoption while allowing a fresh read of the retained instance", async () => {
    const { registry } = registerDiscord();
    const started = createDeferred();
    const response = createDeferred<Response>();
    fetchMock.mockImplementationOnce(async () => {
      started.resolve();
      return await response.promise;
    });
    const outcome = Promise.allSettled([invoke()]);
    try {
      await started.promise;
      setActivePluginRegistry({ ...registry, plugins: [...registry.plugins] });
      response.resolve(jsonResponse(channel));
      const [result] = await outcome;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.reason)).toContain("read authority is no longer active");
      }
      expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).toEqual([channelPath]);
      fetchMock.mockClear();
      await expect(invoke()).resolves.toMatchObject({ details: { ok: true } });
      expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).toEqual([
        channelPath,
        messagesPath,
      ]);
    } finally {
      response.resolve(jsonResponse(channel));
      await outcome;
    }
  });

  it.each([false, true])(
    "checks registrar authority on provider retry (revoked=%s)",
    async (revoked) => {
      vi.useFakeTimers();
      const { revoke } = registerDiscord();
      const limited = createDeferred();
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

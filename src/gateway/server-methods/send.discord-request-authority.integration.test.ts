import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, GatewayRequestHandler, RespondFn } from "./types.js";

const channelId = "100000000000000002";
const guildId = "100000000000000001";
const message = { id: "100000000000000003", channel_id: channelId };
let discordPlugin: ChannelPlugin;
let sendHandler: GatewayRequestHandler;

beforeAll(async () => {
  const { sendHandlers } = await import("./send.js");
  sendHandler = expectDefined(sendHandlers.send, "registered Gateway send handler");
  ({ discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
    pluginId: "discord",
    artifactBasename: "api.js",
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearRuntimeConfigSnapshot();
});

async function createFixture(state: OpenClawTestState) {
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir } },
    channels: {
      discord: {
        enabled: true,
        token: "synthetic-provider-fixture",
        groupPolicy: "allowlist",
        guilds: { [guildId]: { channels: { [channelId]: { enabled: true } } } },
      },
    },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg, cfg);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
  );
  const post = vi.fn<(init?: RequestInit) => Promise<Response>>(async () => Response.json(message));
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.origin === "https://discord.com" && method === "GET") {
        if (url.pathname === `/api/v10/channels/${channelId}`) {
          return Response.json({ id: channelId, guild_id: guildId, type: 0, name: "fixture" });
        }
      }
      if (
        url.origin === "https://discord.com" &&
        url.pathname === `/api/v10/channels/${channelId}/messages` &&
        method === "POST"
      ) {
        return await post(init);
      }
      throw new Error(`Unexpected fake Discord request: ${method} ${url.pathname}`);
    }),
  );
  const caller = new AbortController();
  const respond = vi.fn<RespondFn>();
  const context = {
    getRuntimeConfig: () => cfg,
    dedupe: new Map(),
  } as GatewayRequestContext;
  return {
    post,
    caller,
    respond,
    send: async () =>
      await sendHandler({
        req: { type: "req", id: "discord-caller", method: "send" },
        params: {
          channel: "discord",
          to: `channel:${channelId}`,
          message: "caller lifetime probe",
          sessionKey: `agent:main:discord:channel:${channelId}`,
          idempotencyKey: "discord-caller-lifetime",
        },
        context,
        client: null,
        isWebchatConnect: () => false,
        respond,
        sessionMutationCommitGuard: () => caller.signal.throwIfAborted(),
      }),
  };
}

describe("Gateway send through Discord's default request scheduler", () => {
  it.each(["active", "retired"] as const)(
    "retains the %s caller assertion during a Discord 429 backoff",
    async (state) => {
      // Keep the scheduler's deadline closed until the caller transition is observed.
      vi.useFakeTimers({ toFake: ["Date"] });
      await withOpenClawTestState(
        { prefix: "discord-send-retry-", env: { DISCORD_API_URL: undefined } },
        async (testState) => {
          const fixture = await createFixture(testState);
          const firstPost = createDeferred();
          fixture.post.mockImplementationOnce(async () => {
            firstPost.resolve();
            return Response.json(
              { message: "rate limited", retry_after: 0.1 },
              { status: 429, headers: { "retry-after": "0.1" } },
            );
          });
          const request = fixture.send();
          try {
            await Promise.race([firstPost.promise, request]);
            // Response parsing and scheduler requeueing finish before this event-loop turn.
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(fixture.respond).not.toHaveBeenCalled();
            expect(fixture.post).toHaveBeenCalledOnce();
            if (state === "retired") {
              fixture.caller.abort(new Error("message caller retired during backoff"));
            }
            vi.setSystemTime(Date.now() + 200);
            await request;
            expect(fixture.post).toHaveBeenCalledTimes(state === "active" ? 2 : 1);
            expect(fixture.respond).toHaveBeenCalledOnce();
            expect(fixture.respond.mock.calls[0]?.[0]).toBe(state === "active");
            if (state === "active") {
              expect(fixture.respond.mock.calls[0]?.[1]).toMatchObject({ messageId: message.id });
            }
          } finally {
            vi.useRealTimers();
            await request;
          }
        },
      );
    },
  );

  it("settles an accepted Discord response after the Gateway caller retires", async () => {
    await withOpenClawTestState(
      { prefix: "discord-send-settlement-", env: { DISCORD_API_URL: undefined } },
      async (testState) => {
        const fixture = await createFixture(testState);
        const accepted = createDeferred();
        const releaseResponse = createDeferred();
        fixture.post.mockImplementationOnce(async () => {
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              accepted.resolve();
              await releaseResponse.promise;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(message)));
              controller.close();
            },
          });
          return new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        });
        const request = fixture.send();
        try {
          await Promise.race([accepted.promise, request]);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(fixture.respond).not.toHaveBeenCalled();
          expect(fixture.post).toHaveBeenCalledOnce();
          fixture.caller.abort(new Error("message caller retired after provider acceptance"));
          expect(fixture.post.mock.calls[0]?.[0]?.signal?.aborted).toBe(false);
          releaseResponse.resolve();
          await request;
          expect(fixture.post).toHaveBeenCalledOnce();
          expect(fixture.respond).toHaveBeenCalledOnce();
          expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
          expect(fixture.respond.mock.calls[0]?.[1]).toMatchObject({ messageId: message.id });
        } finally {
          releaseResponse.resolve();
          await request;
        }
      },
    );
  });
});

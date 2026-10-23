import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import {
  createChannelPluginBase,
  createChatChannelPlugin,
  defineChannelPluginEntry,
  type ChannelPlugin,
} from "./channel-core.js";
import {
  createChannelEntryApi as createApi,
  expectLazyChannelSchema,
  registerChannelEntryTestTool,
} from "./channel-entry.test-support.js";

function channelMeta(id: string) {
  return { label: id, selectionLabel: id, docsPath: `/channels/${id}`, blurb: `${id} channel` };
}
function createChannelPlugin(id: string): ChannelPlugin {
  return {
    id,
    meta: { id, ...channelMeta(id) },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => null,
    },
    outbound: { deliveryMode: "direct" },
  };
}

function createEntry() {
  const hooks = {
    setRuntime: vi.fn<(runtime: PluginRuntime) => void>(),
    registerCliMetadata: vi.fn<(api: OpenClawPluginApi) => void>(),
    registerCapabilities: vi.fn<(api: OpenClawPluginApi) => void>(),
    registerFull: vi.fn<(api: OpenClawPluginApi) => void>(),
  };
  const entry = defineChannelPluginEntry({
    id: "runtime-test",
    name: "Runtime Test",
    description: "registration test",
    plugin: createChannelPlugin("runtime-test"),
    ...hooks,
  });
  return { entry, ...hooks };
}

describe("defineChannelPluginEntry", () => {
  it("defers and memoizes config schema factories", () => {
    expectLazyChannelSchema((configSchema) =>
      defineChannelPluginEntry({
        id: "lazy-config-schema",
        name: "Lazy Config Schema",
        description: "lazy config schema test",
        plugin: createChannelPlugin("lazy-config-schema"),
        configSchema,
      }),
    );
  });

  it.each([
    ["cli-metadata", 0, 1, 0, 0],
    ["tool-discovery", 0, 0, 1, 1],
    ["discovery", 1, 1, 0, 1],
    ["setup-only", 1, 0, 0, 0],
    ["setup-runtime", 1, 0, 0, 0],
    ["full", 1, 1, 1, 1],
  ] as const)("registers only the hooks for %s", (mode, runtime, cli, full, capabilities) => {
    const { entry, setRuntime, registerCliMetadata, registerCapabilities, registerFull } =
      createEntry();
    registerFull.mockImplementation(registerChannelEntryTestTool);
    const api = createApi(mode);
    entry.register(api);
    expect(api.registerChannel).toHaveBeenCalledTimes(runtime);
    expect(setRuntime.mock.calls).toEqual(runtime ? [[api.runtime]] : []);
    expect(registerCliMetadata.mock.calls).toEqual(cli ? [[api]] : []);
    expect(registerFull.mock.calls).toEqual(full ? [[api]] : []);
    expect(registerCapabilities.mock.calls).toEqual(capabilities ? [[api]] : []);
    expect(api.registerTool).toHaveBeenCalledTimes(full);
  });
});

it("createChannelPluginBase keeps meta id aligned with the channel id", () => {
  const plugin = createChannelPluginBase({
    id: "metadata-id-channel",
    meta: channelMeta("metadata-id-channel"),
    setup: {} as NonNullable<ChannelPlugin["setup"]>,
  });

  expect(plugin.meta.id).toBe("metadata-id-channel");
});

describe("createChatChannelPlugin", () => {
  describe.each(["sendText", "sendMedia", "sendPoll"] as const)(
    "attached outbound %s",
    (method) => {
      function createSend() {
        if (method === "sendPoll") {
          const context = {
            cfg: {},
            to: "recipient",
            poll: { question: "Choose", options: ["one", "two"] },
          };
          return {
            context,
            run: (outbound: NonNullable<ChannelPlugin["outbound"]>) => outbound.sendPoll!(context),
          };
        }
        const context = {
          cfg: {},
          to: "recipient",
          text: "body",
          ...(method === "sendMedia" ? { mediaUrl: "https://example.com/image.png" } : {}),
        };
        return {
          context,
          run: (outbound: NonNullable<ChannelPlugin["outbound"]>) => outbound[method]!(context),
        };
      }

      it("stamps the configured channel over a stale provider channel", async () => {
        const send = createSend();
        const extra = { correlation: "retained" };
        const providerResult = Object.freeze({
          messageId: "message-1",
          meta: extra,
          channel: "stale-provider-channel",
        });
        const sender = vi.fn(function (this: unknown, _context: unknown) {
          return providerResult;
        });
        const attachedResults = { channel: "configured-channel", [method]: sender };
        const chunker = vi.fn((text: string) => [text]);
        const plugin = createChatChannelPlugin({
          base: createChannelPlugin("configured-channel"),
          outbound: {
            base: { deliveryMode: "direct", chunker, textChunkLimit: 500 },
            attachedResults,
          },
        });

        expect(sender).not.toHaveBeenCalled();
        const result = await send.run(plugin.outbound!);
        expect(result).toEqual({
          channel: "configured-channel",
          messageId: "message-1",
          meta: { correlation: "retained" },
        });
        expect(result).not.toBe(providerResult);
        expect("meta" in result && result.meta).toBe(extra);
        expect(sender).toHaveBeenCalledExactlyOnceWith(send.context);
        expect(sender.mock.contexts[0]).toBe(attachedResults);
        expect(plugin.outbound).toMatchObject({ chunker, textChunkLimit: 500 });
        expect(chunker).not.toHaveBeenCalled();
      });

      it("captures the channel before awaiting the sender and copies result fields afterward", async () => {
        const send = createSend();
        const events: string[] = [];
        let channel = "configured-channel";
        const deferred = createDeferred<{ readonly messageId: string }>();
        const sender = vi.fn(() => {
          events.push("send");
          return deferred.promise;
        });
        const attachedResults = {
          get channel() {
            events.push("channel");
            return channel;
          },
          [method]: sender,
        };
        const plugin = createChatChannelPlugin({
          base: createChannelPlugin("configured-channel"),
          outbound: { base: { deliveryMode: "direct" }, attachedResults },
        });

        expect(events).toEqual([]);
        const result = send.run(plugin.outbound!);
        expect(events).toEqual(["channel", "send"]);
        channel = "later-channel";
        events.push("resolve");
        deferred.resolve({
          get messageId() {
            events.push("result");
            return "message-1";
          },
        });
        await expect(result).resolves.toEqual({
          channel: "configured-channel",
          messageId: "message-1",
        });
        expect(events).toEqual(["channel", "send", "resolve", "result"]);
        expect(sender).toHaveBeenCalledExactlyOnceWith(send.context);
        expect(sender.mock.contexts[0]).toBe(attachedResults);
      });
    },
  );

  it("preserves raw outbound adapters and an inherited adapter when no shorthand is supplied", () => {
    const sender = vi.fn(async () => ({ channel: "raw-channel", messageId: "raw-message" }));
    const outbound = { deliveryMode: "direct" as const, sendText: sender };
    const base = { ...createChannelPlugin("raw-channel"), outbound };

    expect(createChatChannelPlugin({ base, outbound }).outbound).toBe(outbound);
    expect(createChatChannelPlugin({ base }).outbound).toBe(outbound);
    expect(sender).not.toHaveBeenCalled();
  });
  it("preserves DM routing and entry classification through the security shorthand", () => {
    const dmRouting = {
      resolveDmScope: () => "per-peer" as const,
      resolveDmRoute: () => ({ kind: "core" as const }),
    };
    const plugin = createChatChannelPlugin({
      base: createChannelPlugin("security-routing") as ChannelPlugin<{ accountId: string }>,
      security: {
        dm: {
          channelKey: "security-routing",
          resolvePolicy: () => "allowlist",
          resolveAllowFrom: () => [],
          classifyEntryAuthentication: () => "mutable",
        },
        dmRouting,
      },
    });

    expect(plugin.security?.dmRouting).toBe(dmRouting);
    const policy = plugin.security?.resolveDmPolicy?.({
      cfg: {},
      accountId: "default",
      account: { accountId: "default" },
    });
    expect(policy?.classifyEntryAuthentication?.("alias")).toBe("mutable");
  });
});

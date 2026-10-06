/**
 * Tests core plugin SDK exports and channel plugin construction.
 */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "../plugins/types.js";
import {
  createChannelPluginBase,
  createChatChannelPlugin,
  defineChannelPluginEntry,
  type ChannelPlugin,
} from "./channel-core.js";

function createChannelPlugin(id: string): ChannelPlugin {
  return {
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: `${id} channel`,
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => null,
    },
    outbound: { deliveryMode: "direct" },
  };
}

function createApi(registrationMode: PluginRegistrationMode): OpenClawPluginApi {
  return {
    registrationMode,
    runtime: { registrationMode } as unknown as PluginRuntime,
    registerChannel: vi.fn(),
    registerTool: vi.fn(),
  } as unknown as OpenClawPluginApi;
}

describe("defineChannelPluginEntry", () => {
  it("defers and memoizes config schema factories", () => {
    const configSchema = {
      schema: { type: "object" as const, additionalProperties: false },
    };
    const createConfigSchema = vi.fn(() => configSchema);
    const entry = defineChannelPluginEntry({
      id: "lazy-config-schema",
      name: "Lazy Config Schema",
      description: "lazy config schema test",
      plugin: createChannelPlugin("lazy-config-schema"),
      configSchema: createConfigSchema,
    });

    expect(createConfigSchema).not.toHaveBeenCalled();
    expect(entry.configSchema).toBe(configSchema);
    expect(entry.configSchema).toBe(configSchema);
    expect(createConfigSchema).toHaveBeenCalledTimes(1);
  });

  it("runs tool registrations without channel runtime wiring during tool discovery", () => {
    const setRuntime = vi.fn<(runtime: PluginRuntime) => void>();
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerCapabilities = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>((api) => {
      api.registerTool(
        {
          name: "channel_tool",
          label: "Channel Tool",
          description: "channel tool",
          parameters: {},
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
        },
        { name: "channel_tool" },
      );
    });
    const entry = defineChannelPluginEntry({
      id: "runtime-tool-discovery",
      name: "Runtime Tool Discovery",
      description: "runtime tool discovery test",
      plugin: createChannelPlugin("runtime-tool-discovery"),
      setRuntime,
      registerCliMetadata,
      registerFull,
      registerCapabilities,
    });

    const api = createApi("tool-discovery");
    entry.register(api);

    expect(api.registerChannel).not.toHaveBeenCalled();
    expect(setRuntime).not.toHaveBeenCalled();
    expect(registerCliMetadata).not.toHaveBeenCalled();
    expect(registerFull).toHaveBeenCalledWith(api);
    expect(registerCapabilities).toHaveBeenCalledExactlyOnceWith(api);
    expect(api.registerTool).toHaveBeenCalledTimes(1);
  });

  it("wires runtime helpers during discovery registration", () => {
    const setRuntime = vi.fn<(runtime: PluginRuntime) => void>();
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerCapabilities = vi.fn<(api: OpenClawPluginApi) => void>();
    const entry = defineChannelPluginEntry({
      id: "runtime-discovery",
      name: "Runtime Discovery",
      description: "runtime discovery test",
      plugin: createChannelPlugin("runtime-discovery"),
      setRuntime,
      registerCliMetadata,
      registerFull,
      registerCapabilities,
    });

    const api = createApi("discovery");
    entry.register(api);

    expect(api.registerChannel).toHaveBeenCalledTimes(1);
    expect(registerCliMetadata).toHaveBeenCalledTimes(1);
    expect(setRuntime).toHaveBeenCalledWith(api.runtime);
    expect(registerFull).not.toHaveBeenCalled();
    expect(registerCapabilities).toHaveBeenCalledExactlyOnceWith(api);
  });

  it("keeps setup-runtime and full registration wired to runtime helpers", () => {
    const setRuntime = vi.fn<(runtime: PluginRuntime) => void>();
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerCapabilities = vi.fn<(api: OpenClawPluginApi) => void>();
    const entry = defineChannelPluginEntry({
      id: "runtime-activation",
      name: "Runtime Activation",
      description: "runtime activation test",
      plugin: createChannelPlugin("runtime-activation"),
      setRuntime,
      registerCliMetadata,
      registerFull,
      registerCapabilities,
    });

    const cliApi = createApi("cli-metadata");
    entry.register(cliApi);
    expect(registerCliMetadata).toHaveBeenCalledWith(cliApi);
    expect(registerCapabilities).not.toHaveBeenCalled();
    registerCliMetadata.mockClear();

    entry.register(createApi("setup-only"));
    expect(registerCapabilities).not.toHaveBeenCalled();

    const setupApi = createApi("setup-runtime");
    entry.register(setupApi);
    expect(setRuntime).toHaveBeenCalledWith(setupApi.runtime);
    expect(registerCliMetadata).not.toHaveBeenCalled();
    expect(registerFull).not.toHaveBeenCalled();
    expect(registerCapabilities).not.toHaveBeenCalled();

    setRuntime.mockClear();
    const fullApi = createApi("full");
    entry.register(fullApi);
    expect(setRuntime).toHaveBeenCalledWith(fullApi.runtime);
    expect(registerCliMetadata).toHaveBeenCalledWith(fullApi);
    expect(registerFull).toHaveBeenCalledWith(fullApi);
    expect(registerCapabilities).toHaveBeenCalledExactlyOnceWith(fullApi);
  });
});

describe("createChannelPluginBase", () => {
  it("keeps meta id aligned with the channel id", () => {
    const plugin = createChannelPluginBase({
      id: "metadata-id-channel",
      meta: {
        label: "Metadata ID Channel",
        selectionLabel: "Metadata ID Channel",
        docsPath: "/channels/metadata-id-channel",
        blurb: "metadata id channel",
      },
      setup: {} as NonNullable<ChannelPlugin["setup"]>,
    });

    expect(plugin.meta.id).toBe("metadata-id-channel");
  });
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

      it.each([
        { label: "no provider channel", metadata: {} },
        { label: "matching provider channel", metadata: { channel: "configured-channel" } },
        { label: "stale provider channel", metadata: { channel: "stale-provider-channel" } },
      ])("stamps the configured channel with $label", async ({ metadata }) => {
        const send = createSend();
        const extra = { correlation: "retained" };
        const providerResult = Object.freeze({ messageId: "message-1", meta: extra, ...metadata });
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
        expect(plugin.outbound?.chunker).toBe(chunker);
        expect(plugin.outbound?.textChunkLimit).toBe(500);
        expect(chunker).not.toHaveBeenCalled();
      });

      it.each(["throw", "reject"] as const)("preserves a sender %s", async (failure) => {
        const send = createSend();
        const error = new Error("provider failure");
        const sender = vi.fn(() => {
          if (failure === "throw") {
            throw error;
          }
          return Promise.reject(error);
        });
        const attachedResults = { channel: "configured-channel", [method]: sender };
        const plugin = createChatChannelPlugin({
          base: createChannelPlugin("configured-channel"),
          outbound: { base: { deliveryMode: "direct" }, attachedResults },
        });

        await expect(send.run(plugin.outbound!)).rejects.toBe(error);
        expect(sender).toHaveBeenCalledExactlyOnceWith(send.context);
        expect(sender.mock.contexts[0]).toBe(attachedResults);
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

      it("keeps omitted sender methods unavailable", () => {
        const sender = vi.fn(() => ({ messageId: "message-1" }));
        const plugin = createChatChannelPlugin({
          base: createChannelPlugin("configured-channel"),
          outbound: {
            base: { deliveryMode: "direct" },
            attachedResults: { channel: "configured-channel", [method]: sender },
          },
        });

        for (const name of ["sendText", "sendMedia", "sendPoll"] as const) {
          expect(Object.hasOwn(plugin.outbound!, name)).toBe(true);
          if (name === method) {
            expect(plugin.outbound?.[name]).toBeTypeOf("function");
          } else {
            expect(plugin.outbound?.[name]).toBeUndefined();
          }
        }
        expect(sender).not.toHaveBeenCalled();
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

  it("preserves account-scoped current-conversation binding support", () => {
    const conversationBindings: NonNullable<ChannelPlugin["conversationBindings"]> = {
      isCurrentConversationBindingSupported: ({ accountId }) => accountId !== "enterprise",
    };
    const plugin = createChatChannelPlugin({
      base: {
        ...createChannelPlugin("account-scoped-bindings"),
        conversationBindings,
      },
    });

    expect(plugin.conversationBindings?.supportsCurrentConversationBinding).toBe(true);
    expect(
      plugin.conversationBindings?.isCurrentConversationBindingSupported?.({
        accountId: "workspace",
      }),
    ).toBe(true);
    expect(
      plugin.conversationBindings?.isCurrentConversationBindingSupported?.({
        accountId: "enterprise",
      }),
    ).toBe(false);
  });

  it("exports the conversation route-owner result contract", () => {
    const messaging = {
      resolveConversationRouteOwner: ({ conversation }) =>
        conversation.peerId === "retry"
          ? ({ kind: "unavailable" } as const)
          : ({ kind: "agent", agentId: "main" } as const),
    } satisfies NonNullable<ChannelPlugin["messaging"]>;

    expect(
      messaging.resolveConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "direct", peerId: "retry" },
      }),
    ).toEqual({ kind: "unavailable" });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { registerPluginCommandInRegistry } from "./command-registration.js";
import {
  createPluginCommandRuntime,
  matchPluginCommandInvocation,
} from "./plugin-command-runtime.js";
import type { PluginCommandContext } from "./plugin-command.types.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

afterEach(() => resetPluginRuntimeStateForTest());

describe("invocation conversation metadata through real command dispatch", () => {
  it("exposes a versioned fork host only for a resolved session conversation", async () => {
    const registry = createTestRegistry([
      {
        pluginId: "room-chat",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "room-chat",
            config: { defaultAccountId: () => "account-a" },
          }),
          bindings: {
            resolveCommandConversation: () => ({
              conversationId: "topic-a",
              parentConversationId: "room-a",
            }),
          },
        },
      },
    ]);
    expect(
      registerPluginCommandInRegistry(registry, "fork-host-proof", {
        name: "fork-host-proof",
        description: "Inspect fork host",
        requireAuth: false,
        handler: (ctx) => ({ text: String(ctx.runtimeContext?.conversationFork?.version) }),
      }),
    ).toEqual({ ok: true });
    const match = withPluginRuntimeRegistryScope(registry, () =>
      matchPluginCommandInvocation(createPluginCommandRuntime(), "/fork-host-proof", {
        channel: "room-chat",
      }),
    );
    const result = await match!.dispatch.execute({
      channel: "room-chat",
      senderId: "sender-a",
      isAuthorizedSender: true,
      commandBody: "/fork-host-proof",
      config: {},
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    expect(result).toEqual({ text: "1" });

    const unauthorized = await match!.dispatch.execute({
      channel: "room-chat",
      senderId: "sender-b",
      isAuthorizedSender: false,
      commandBody: "/fork-host-proof",
      config: {},
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    expect(unauthorized).toEqual({ text: "undefined" });
  });

  it.each(["success", "throw", "retire", "unauthorized", "unresolved"] as const)(
    "captures canonical scope and closes retained reader: %s",
    async (mode) => {
      const registry = createTestRegistry([
        {
          pluginId: "room-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "room-chat",
              config: { defaultAccountId: () => "account-a" },
            }),
            bindings: {
              resolveCommandConversation: () =>
                mode === "unresolved"
                  ? null
                  : { conversationId: "topic-a", parentConversationId: "room-a" },
            },
          },
        },
      ]);
      type Reader = NonNullable<
        NonNullable<PluginCommandContext["runtimeContext"]>["getCurrentConversation"]
      >;
      let reader: Reader | undefined;
      let during: ReturnType<Reader> | undefined;
      let afterRetirement: ReturnType<Reader> | undefined;
      expect(
        registerPluginCommandInRegistry(registry, "metadata-proof", {
          name: "metadata-proof",
          description: "Inspect invocation metadata",
          requireAuth: false,
          handler: async (ctx) => {
            reader = ctx.runtimeContext?.getCurrentConversation;
            during = reader?.();
            await Promise.resolve();
            if (mode === "retire") {
              markPluginRegistryRetired(registry);
              afterRetirement = reader?.();
            }
            if (mode === "throw") {
              throw new Error("synthetic handler failure");
            }
            return { text: "observed" };
          },
        }),
      ).toEqual({ ok: true });
      const match = withPluginRuntimeRegistryScope(registry, () =>
        matchPluginCommandInvocation(createPluginCommandRuntime(), "/metadata-proof", {
          channel: "room-chat",
        }),
      );
      expect(match).not.toBeNull();
      const result = await match!.dispatch.execute({
        channel: "room-chat",
        senderId: "sender-a",
        isAuthorizedSender: mode !== "unauthorized",
        commandBody: "/metadata-proof",
        config: {},
        sessionKey: "agent:main:main",
      });
      expect(result).toEqual({
        text: mode === "throw" ? "⚠️ Command failed. Please try again later." : "observed",
      });
      expect(reader).toBeTypeOf("function");
      if (mode === "unauthorized" || mode === "unresolved") {
        expect(during).toBeNull();
      } else {
        expect(during).toEqual({
          channel: "room-chat",
          accountId: "account-a",
          conversationId: "topic-a",
          parentConversationId: "room-a",
        });
        expect(Object.isFrozen(during)).toBe(true);
      }
      if (mode === "retire") {
        expect(afterRetirement).toBeNull();
      }
      expect(reader!()).toBeNull();
    },
  );
});

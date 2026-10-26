/** Tests command-control detection and authorization trigger heuristics. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearPluginCommands, registerPluginCommand } from "../plugins/commands.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCommandAuthorization, resolveCommandAuthorizationAsync } from "./command-auth.js";
import {
  hasCommandSyntax,
  hasControlCommand,
  hasInlineCommandTokens,
  shouldComputeCommandAuthorized,
} from "./command-detection.js";
import { parseActivationCommand } from "./group-activation.js";
import { markInboundContextLabel } from "./reply/inbound-context-marker.js";
import { resolveAuthorizedSessionResetCommand } from "./reply/session-reset-command.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

afterEach(() => {
  clearPluginCommands();
});

function authorize(ctx: MsgContext, cfg: OpenClawConfig, commandAuthorized = true) {
  return resolveCommandAuthorization({ ctx, cfg, commandAuthorized });
}

describe("resolveCommandAuthorization", () => {
  const formatAllowFrom = ({ allowFrom }: { allowFrom: Array<string | number> }) => {
    const values: string[] = [];
    for (const entry of allowFrom) {
      const value = String(entry).trim();
      if (value) {
        values.push(value);
      }
    }
    return values;
  };

  function createAllowFromPlugin(
    id: string,
    resolveAllowFrom: () => Array<string | number> | undefined,
  ) {
    return {
      pluginId: id,
      plugin: {
        ...createOutboundTestPlugin({
          id,
          outbound: { deliveryMode: "direct" },
        }),
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          resolveAllowFrom,
          formatAllowFrom,
        },
      },
      source: "test" as const,
    };
  }

  function createThrowingAllowFromPlugin(id: string, error: string) {
    return createAllowFromPlugin(id, () => {
      throw new Error(error);
    });
  }

  function createOwnerEnforcingAllowFromPlugin(
    id: string,
    resolveAllowFrom: () => Array<string | number> | undefined,
  ) {
    const entry = createAllowFromPlugin(id, resolveAllowFrom);
    return {
      ...entry,
      plugin: {
        ...entry.plugin,
        commands: { enforceOwnerForCommands: true },
      },
    };
  }

  function registerAllowFromPlugins(
    ...plugins: Array<
      ReturnType<typeof createAllowFromPlugin> & {
        plugin: {
          config: { resolveAllowFromAsync?: () => Promise<Array<string | number> | undefined> };
        };
      }
    >
  ) {
    setActivePluginRegistry(createTestRegistry(plugins));
  }

  it.each(["explicit", "inferred"] as const)(
    "uses asynchronous channel allowlists for %s command authorization",
    async (providerSource) => {
      const resolveLegacy = vi.fn(() => ["legacy-owner"]);
      const entry = createOwnerEnforcingAllowFromPlugin("telegram", resolveLegacy);
      registerAllowFromPlugins({
        ...entry,
        plugin: {
          ...entry.plugin,
          config: {
            ...entry.plugin.config,
            resolveAllowFromAsync: async () => ["async-owner"],
          },
        },
      });
      const authorization = await resolveCommandAuthorizationAsync({
        ctx: {
          Provider: providerSource === "explicit" ? "telegram" : undefined,
          SenderId: "async-owner",
        },
        cfg: {},
        commandAuthorized: true,
      });
      expect(authorization).toMatchObject({ providerId: "telegram", isAuthorizedSender: true });
      expect(resolveLegacy).not.toHaveBeenCalled();
    },
  );

  it("does not recover a failed async allowlist through the synchronous hook", async () => {
    const resolveLegacy = vi.fn(() => ["owner"]);
    const entry = createOwnerEnforcingAllowFromPlugin("telegram", resolveLegacy);
    registerAllowFromPlugins({
      ...entry,
      plugin: {
        ...entry.plugin,
        config: {
          ...entry.plugin.config,
          resolveAllowFromAsync: async () => {
            throw new Error("unavailable");
          },
        },
      },
    });
    using _ = vi.spyOn(console, "warn").mockImplementation(() => {});

    const authorization = await resolveCommandAuthorizationAsync({
      ctx: { SenderId: "owner" },
      cfg: { commands: { allowFrom: { "*": ["owner"] } } },
      commandAuthorized: true,
    });
    expect(authorization.isAuthorizedSender).toBe(false);
    expect(resolveLegacy).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "uses explicit owner allowlist when allowFrom is wildcard",
      channelConfig: { allowFrom: ["*"] },
    },
  ])("$name", ({ channelConfig }) => {
    const cfg = {
      commands: { ownerAllowFrom: ["whatsapp:+15551234567"] },
      channels: { whatsapp: channelConfig },
    } as OpenClawConfig;
    const resolveSender = (senderId: string) =>
      authorize(
        {
          Provider: "whatsapp",
          Surface: "whatsapp",
          From: `whatsapp:${senderId}`,
          SenderE164: senderId,
        } as MsgContext,
        cfg,
      );

    const ownerAuth = resolveSender("+15551234567");
    expect(ownerAuth.senderIsOwner).toBe(true);
    expect(ownerAuth.isAuthorizedSender).toBe(true);

    const otherAuth = resolveSender("+19995551234");
    expect(otherAuth.senderIsOwner).toBe(false);
    expect(otherAuth.isAuthorizedSender).toBe(false);
  });

  it("uses context owner candidates for command authorization without granting owner status", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: createOutboundTestPlugin({
            id: "discord",
            outbound: { deliveryMode: "direct" },
          }),
          source: "test",
        },
      ]),
    );
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:123",
      SenderId: "123",
      OwnerAllowFrom: ["discord:123"],
    } as MsgContext;

    const auth = authorize(ctx, cfg);

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.ownerList).toEqual([]);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("does not infer a provider from channel allowlists for webchat command contexts", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+15551234567"] } },
    } as OpenClawConfig;

    const ctx = {
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      SenderId: "openclaw-control-ui",
    } as MsgContext;

    const auth = authorize(ctx, cfg);

    expect(auth.providerId).toBeUndefined();
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it.each([
    {
      name: "does not apply channel-prefixed owner identities to webchat command contexts",
      owner: "discord:123456789012345678",
      provider: "webchat",
      expectedProvider: undefined,
      expectedOwner: false,
    },
    {
      name: "leaves retired channel-qualified owner migration to Doctor",
      owner: "discord:user:123456789012345678",
      provider: "discord",
      expectedProvider: "discord",
      expectedOwner: false,
    },
    {
      name: "does not apply channel-prefixed owner wildcards to mismatched providers",
      owner: "telegram:*",
      provider: "discord",
      expectedProvider: "discord",
      expectedOwner: false,
    },
  ] as const)("$name", ({ owner, provider, expectedProvider, expectedOwner }) => {
    const webchat = provider === "webchat";
    const auth = authorize(
      {
        Provider: provider,
        Surface: provider,
        ...(webchat
          ? { OriginatingChannel: "webchat", GatewayClientScopes: ["operator.write"] }
          : { From: "discord:123456789012345678" }),
        SenderId: "123456789012345678",
      } as MsgContext,
      { commands: { ownerAllowFrom: [owner] } } as OpenClawConfig,
    );

    expect(auth.providerId).toBe(expectedProvider);
    expect(auth.senderIsOwner).toBe(expectedOwner);
  });

  it("preserves external channel command auth in mixed webchat contexts", () => {
    const cfg = {
      commands: { allowFrom: { whatsapp: ["+15551234567"] } },
      channels: { whatsapp: { allowFrom: ["+15551234567"] } },
    } as OpenClawConfig;

    const auth = authorize(
      {
        Provider: "webchat",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        From: "whatsapp:+19995551234",
        SenderE164: "+19995551234",
      } as MsgContext,
      cfg,
    );

    expect(auth.providerId).toBe("whatsapp");
    expect(auth.isAuthorizedSender).toBe(false);
  });

  describe("commands.allowFrom", () => {
    const commandsAllowFromConfig = {
      commands: {
        allowFrom: {
          "*": ["user123"],
        },
      },
      channels: { whatsapp: { allowFrom: ["+different"] } },
    } as OpenClawConfig;

    function makeWhatsAppContext(senderId: string): MsgContext {
      return {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: `whatsapp:${senderId}`,
        SenderId: senderId,
      } as MsgContext;
    }

    function resolveWithCommandsAllowFrom(senderId: string, commandAuthorized: boolean) {
      return authorize(makeWhatsAppContext(senderId), commandsAllowFromConfig, commandAuthorized);
    }

    it("ignores commandAuthorized when commands.allowFrom is configured", () => {
      const authorizedAuth = resolveWithCommandsAllowFrom("user123", false);

      expect(authorizedAuth.isAuthorizedSender).toBe(true);

      const unauthorizedAuth = resolveWithCommandsAllowFrom("otheruser", false);

      expect(unauthorizedAuth.isAuthorizedSender).toBe(false);
    });

    it("uses commands.allowFrom provider-specific list over global", () => {
      const cfg = {
        commands: {
          allowFrom: {
            "*": ["globaluser"],
            whatsapp: ["+15551234567"],
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      // User in global list but not in whatsapp-specific list
      const globalUserCtx = {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:globaluser",
        SenderId: "globaluser",
      } as MsgContext;

      const globalAuth = authorize(globalUserCtx, cfg);

      // Provider-specific list overrides global, so globaluser is not authorized
      expect(globalAuth.isAuthorizedSender).toBe(false);

      // User in whatsapp-specific list
      const whatsappUserCtx = {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:+15551234567",
        SenderE164: "+15551234567",
      } as MsgContext;

      const whatsappAuth = authorize(whatsappUserCtx, cfg);

      expect(whatsappAuth.isAuthorizedSender).toBe(true);
    });

    it("requires owner identity before commands.allowFrom when the plugin enforces owner-only commands", () => {
      registerAllowFromPlugins(createOwnerEnforcingAllowFromPlugin("telegram", () => ["*"]));
      const cfg = {
        commands: {
          allowFrom: {
            "*": ["*"],
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      const auth = authorize(
        {
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          From: "telegram:999",
          SenderId: "999",
          CommandSource: "native",
        } as MsgContext,
        cfg,
      );

      expect(auth.senderIsOwner).toBe(false);
      expect(auth.isAuthorizedSender).toBe(false);
    });

    it("keeps commands.allowFrom available to non-owner command users when an owner allowlist is configured", () => {
      const cfg = {
        commands: {
          ownerAllowFrom: ["discord:owner"],
          allowFrom: {
            discord: ["helper"],
          },
        },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      const auth = authorize(
        {
          Provider: "discord",
          Surface: "discord",
          ChatType: "group",
          From: "discord:helper",
          SenderId: "helper",
          CommandSource: "native",
        } as MsgContext,
        cfg,
      );

      expect(auth.senderIsOwner).toBe(false);
      expect(auth.isAuthorizedSender).toBe(true);
    });

    it.each([
      {
        name: "does not treat conversation ids in From as sender identities",
        provider: "discord",
        chatType: "channel",
        from: "discord:channel:123456789012345678",
        senderId: "999999999999999999",
        senderE164: undefined,
        allowFrom: { discord: ["channel:123456789012345678"] },
        expected: false,
      },
      {
        name: "still falls back to From for direct messages when sender fields are absent",
        provider: "discord",
        chatType: "direct",
        from: "discord:123456789012345678",
        senderId: " ",
        senderE164: " ",
        allowFrom: { discord: ["123456789012345678"] },
        expected: true,
      },
      {
        name: "does not fall back to conversation-shaped From when chat type is missing",
        provider: "whatsapp",
        chatType: undefined,
        from: "demo:group:room-1",
        senderId: " ",
        senderE164: " ",
        allowFrom: { "*": ["demo:group:room-1"] },
        expected: false,
      },
    ] as const)(
      "$name",
      ({ provider, chatType, from, senderId, senderE164, allowFrom, expected }) => {
        const auth = authorize(
          {
            Provider: provider,
            Surface: provider,
            ChatType: chatType,
            From: from,
            SenderId: senderId,
            SenderE164: senderE164,
          } as MsgContext,
          { commands: { allowFrom } } as unknown as OpenClawConfig,
          false,
        );

        expect(auth.isAuthorizedSender).toBe(expected);
      },
    );

    it.each([
      {
        name: "fails closed when provider inference hits unresolved SecretRef allowlists",
        failingProvider: "telegram",
        allowKey: "telegram",
        channelMode: "configured",
        validTelegram: false,
        commandAuthorized: false,
        expectedProvider: "telegram",
        expectedAuthorized: false,
      },
      {
        name: "preserves provider resolution errors when inferred fallback allowFrom is empty",
        failingProvider: "telegram",
        allowKey: "telegram",
        channelMode: "empty",
        validTelegram: false,
        commandAuthorized: true,
        expectedProvider: undefined,
        expectedAuthorized: false,
      },
      {
        name: "does not let an unrelated provider resolution error poison inferred commands.allowFrom",
        failingProvider: "slack",
        allowKey: "telegram",
        channelMode: "configured",
        validTelegram: true,
        commandAuthorized: false,
        expectedProvider: "telegram",
        expectedAuthorized: true,
      },
    ] as const)(
      "$name",
      async ({
        failingProvider,
        allowKey,
        channelMode,
        validTelegram,
        commandAuthorized,
        expectedProvider,
        expectedAuthorized,
      }) => {
        registerAllowFromPlugins(
          ...(validTelegram ? [createAllowFromPlugin("telegram", () => ["123"])] : []),
          createThrowingAllowFromPlugin(
            failingProvider,
            `channels.${failingProvider}.${failingProvider === "telegram" ? "botToken" : "token"}: unresolved SecretRef`,
          ),
        );
        const channelId = validTelegram ? "telegram" : failingProvider;
        const channelConfig = channelMode === "configured" ? { allowFrom: ["123"] } : {};
        const params = {
          ctx: { SenderId: "123", commandText: "/reset", rawText: "/reset" } as MsgContext,
          cfg: {
            commands: { allowFrom: { [allowKey]: ["123"] } },
            channels: { [channelId]: channelConfig },
          } as OpenClawConfig,
          commandAuthorized,
        };
        const auth = resolveCommandAuthorization(params);
        const reset = await resolveAuthorizedSessionResetCommand({
          ...params,
          agentId: "main",
          isGroup: false,
        });

        expect(auth.providerId).toBe(expectedProvider);
        expect(auth.isAuthorizedSender).toBe(expectedAuthorized);
        expect(reset.resetAuthorized).toBe(expectedAuthorized);
        expect(reset.resetCommand.matchedResetTriggerLower).toBe(
          expectedAuthorized ? "/reset" : undefined,
        );
      },
    );

    it("preserves default-account allowFrom on SecretRef fallback", () => {
      registerAllowFromPlugins(
        createThrowingAllowFromPlugin(
          "telegram",
          "channels.telegram.botToken: unresolved SecretRef",
        ),
      );

      const auth = authorize(
        {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        } as MsgContext,
        {
          channels: {
            telegram: {
              accounts: {
                default: {
                  allowFrom: ["123"],
                },
              },
            },
          },
        } as OpenClawConfig,
      );

      expect(auth.ownerList).toEqual([]);
      expect(auth.senderIsOwner).toBe(false);
      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("does not log raw resolution messages from thrown allowFrom errors", () => {
      registerAllowFromPlugins(createThrowingAllowFromPlugin("telegram", "SECRET-TOKEN-123"));

      using warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      authorize(
        {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        } as MsgContext,
        {
          channels: {
            telegram: {
              allowFrom: ["123"],
            },
          },
        } as OpenClawConfig,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = String(warn.mock.calls[0]?.[0] ?? "");
      expect(warning).toContain("Error");
      expect(warning).not.toContain("SECRET-TOKEN-123");
    });
  });

  it.each([
    {
      name: "grants senderIsOwner for internal channel with operator.admin scope",
      provider: "webchat",
      scope: "operator.admin",
      expectedOwner: true,
    },
    {
      name: "does not grant senderIsOwner for internal channel without admin scope",
      provider: "webchat",
      scope: "operator.approvals",
      expectedOwner: false,
    },
    {
      name: "does not grant senderIsOwner for external channel even with admin scope",
      provider: "telegram",
      scope: "operator.admin",
      expectedOwner: false,
    },
  ] as const)("$name", ({ provider, scope, expectedOwner }) => {
    const auth = authorize(
      {
        Provider: provider,
        Surface: provider,
        ...(provider === "telegram" ? { From: "telegram:12345" } : {}),
        GatewayClientScopes: [scope],
      } as MsgContext,
      {} as OpenClawConfig,
    );
    expect(auth.senderIsOwner).toBe(expectedOwner);
  });
});

describe("control command parsing", () => {
  function expectCases(
    parse: (value: string) => unknown,
    cases: readonly (readonly [string, unknown])[],
  ) {
    cases.forEach(([value, expected]) => expect(parse(value)).toEqual(expected));
  }

  it("requires slash for activation", () => {
    expectCases(parseActivationCommand, [
      ["/activation mention", { hasCommand: true, mode: "mention" }],
      ["/activation: mention", { hasCommand: true, mode: "mention" }],
      ["/activation:", { hasCommand: true }],
      ["activation mention", { hasCommand: false }],
    ]);
  });

  it("respects disabled config/debug commands", () => {
    const cfg = { commands: { config: false, debug: false } };
    expect(hasControlCommand("/config show", cfg)).toBe(false);
    expect(hasControlCommand("/debug show", cfg)).toBe(false);
  });

  it("detects inline command tokens", () => {
    expect(hasInlineCommandTokens("hello /status")).toBe(true);
    expect(hasInlineCommandTokens("hey /think high")).toBe(true);
    expect(hasInlineCommandTokens("/ pair qr")).toBe(false);
    expect(hasInlineCommandTokens("hey / pair qr")).toBe(false);
    expect(hasInlineCommandTokens("option A / B")).toBe(false);
    expect(hasInlineCommandTokens("plain text")).toBe(false);
    expect(hasInlineCommandTokens("http://example.com/path")).toBe(false);
    expect(hasInlineCommandTokens("stop")).toBe(false);
  });

  it.each(["!", "! poll", "!(echo fixture)", "@bot ! poll", "@bot !(echo fixture)"])(
    "requests authorization for bash input without granting mention bypass: %s",
    (body) => {
      expect(shouldComputeCommandAuthorized(body)).toBe(true);
      expect(hasControlCommand(body)).toBe(false);
    },
  );

  it.each([
    "![diagram](https://example.com/diagram.png)",
    "![nested [diagram]][figure]",
    "@bot ![diagram](https://example.com/diagram.png)",
  ])("keeps Markdown images out of command classification: %s", (body) => {
    expect(hasCommandSyntax(body)).toBe(false);
    expect(shouldComputeCommandAuthorized(body)).toBe(false);
    expect(hasControlCommand(body)).toBe(false);
  });

  it("detects spaced syntax only for active registered plugin commands", () => {
    expect(shouldComputeCommandAuthorized("/ pair qr")).toBe(false);

    registerPluginCommand("device-pair", {
      name: "pair",
      description: "Pair command",
      acceptsArgs: true,
      handler: async () => ({ text: "ok" }),
    });

    expect(shouldComputeCommandAuthorized("/ pair qr")).toBe(true);
    expect(shouldComputeCommandAuthorized("@openclaw / pair qr")).toBe(true);
    expect(shouldComputeCommandAuthorized("hey / pair qr")).toBe(true);

    clearPluginCommands();
    expect(shouldComputeCommandAuthorized("/ pair qr")).toBe(false);
  });

  it("ignores telegram commands addressed to other bots", () => {
    expect(
      hasControlCommand("/help@otherbot", undefined, {
        botUsername: "openclaw",
      }),
    ).toBe(false);
    expect(
      hasControlCommand("/help@openclaw", undefined, {
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });

  function expectCommandAfterMetadata(label: string, json: string, command: string) {
    expect(hasControlCommand([label, "```json", json, "```", "", command].join("\n"))).toBe(true);
  }

  it("detects commands wrapped in inbound metadata blocks", () => {
    expectCommandAfterMetadata(
      markInboundContextLabel("Conversation info:"),
      '{"message_id":"msg-abc","chat_id":"chat-123"}',
      "/model spark",
    );
  });

  it("detects /status command after timestamp + metadata prefix", () => {
    expectCommandAfterMetadata(
      `[Wed 2026-03-11 23:51 PDT] ${markInboundContextLabel("Conversation info:")}`,
      '{"chat_id":"chat-123"}',
      "/status",
    );
  });
});

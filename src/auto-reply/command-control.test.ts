/** Tests command-control detection and authorization trigger heuristics. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearPluginCommands, registerPluginCommand } from "../plugins/commands.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCommandAuthorization, resolveCommandAuthorizationAsync } from "./command-auth.js";
import {
  hasControlCommand,
  hasInlineCommandTokens,
  shouldComputeCommandAuthorized,
} from "./command-detection.js";
import { parseActivationCommand } from "./group-activation.js";
import { markInboundContextLabel } from "./reply/inbound-context-marker.js";
import { resolveAuthorizedSessionResetCommand } from "./reply/session-reset-command.js";
import { parseSendPolicyCommand } from "./send-policy.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

afterEach(() => {
  clearPluginCommands();
});

function channelContext(provider: string, fields: Partial<MsgContext> = {}): MsgContext {
  return { Provider: provider, Surface: provider, ...fields };
}

function authorize(ctx: MsgContext, cfg: OpenClawConfig, commandAuthorized = true) {
  return resolveCommandAuthorization({ ctx, cfg, commandAuthorized });
}

describe("resolveCommandAuthorization", () => {
  const formatAllowFrom = ({ allowFrom }: { allowFrom: Array<string | number> }) => {
    return allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
  };

  function createAllowFromPlugin(
    id: string,
    resolveAllowFrom: () => Array<string | number> | undefined,
  ) {
    return {
      pluginId: id,
      plugin: {
        ...createOutboundTestPlugin({ id, outbound: { deliveryMode: "direct" } }),
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
    return { ...entry, plugin: { ...entry.plugin, commands: { enforceOwnerForCommands: true } } };
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

  function installAsyncAllowlist(
    resolveAllowFromAsync: () => Promise<string[]>,
    resolveLegacy: () => string[],
  ) {
    const entry = createOwnerEnforcingAllowFromPlugin("telegram", resolveLegacy);
    registerAllowFromPlugins({
      ...entry,
      plugin: { ...entry.plugin, config: { ...entry.plugin.config, resolveAllowFromAsync } },
    });
  }

  it.each(["explicit", "inferred"] as const)(
    "uses asynchronous channel allowlists for %s command authorization",
    async (providerSource) => {
      const resolveLegacy = vi.fn(() => ["legacy-owner"]);
      installAsyncAllowlist(async () => ["async-owner"], resolveLegacy);
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
    installAsyncAllowlist(async () => {
      throw new Error("unavailable");
    }, resolveLegacy);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const authorization = await resolveCommandAuthorizationAsync({
        ctx: { SenderId: "owner" },
        cfg: { commands: { allowFrom: { "*": ["owner"] } } },
        commandAuthorized: true,
      });
      expect(authorization.isAuthorizedSender).toBe(false);
      expect(resolveLegacy).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("uses explicit owner allowlist when allowFrom is wildcard", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["whatsapp:+15551234567"] },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const resolveSender = (senderId: string) =>
      authorize(
        channelContext("whatsapp", {
          From: `whatsapp:${senderId}`,
          SenderE164: senderId,
        }),
        cfg,
      );

    const ownerAuth = resolveSender("+15551234567");
    expect(ownerAuth).toMatchObject({ senderIsOwner: true, isAuthorizedSender: true });

    const otherAuth = resolveSender("+19995551234");
    expect(otherAuth).toMatchObject({ senderIsOwner: false, isAuthorizedSender: false });
  });

  it("uses context owner candidates for command authorization without granting owner status", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: createOutboundTestPlugin({ id: "discord", outbound: { deliveryMode: "direct" } }),
          source: "test",
        },
      ]),
    );
    const ctx = channelContext("discord", {
      From: "discord:123",
      SenderId: "123",
      OwnerAllowFrom: ["discord:123"],
    });
    expect(authorize(ctx, { channels: { discord: {} } })).toMatchObject({
      senderIsOwner: false,
      ownerList: [],
      isAuthorizedSender: true,
    });
  });

  it("does not infer a provider from channel allowlists for webchat command contexts", () => {
    const cfg = { channels: { whatsapp: { allowFrom: ["+15551234567"] } } } as OpenClawConfig;
    const ctx = channelContext("webchat", {
      OriginatingChannel: "webchat",
      SenderId: "openclaw-control-ui",
    });
    const auth = authorize(ctx, cfg);
    expect(auth.providerId).toBeUndefined();
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it.each([
    [
      "webchat excludes channel-prefixed owners",
      "discord:123456789012345678",
      "webchat",
      undefined,
    ],
    [
      "Doctor owns retired channel-qualified identities",
      "discord:user:123456789012345678",
      "discord",
      "discord",
    ],
    ["provider wildcards cannot cross channels", "telegram:*", "discord", "discord"],
  ] as const)("%s", (_name, owner, provider, expectedProvider) => {
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
    expect(auth.senderIsOwner).toBe(false);
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
      commands: { allowFrom: { "*": ["user123"] } },
      channels: { whatsapp: { allowFrom: ["+different"] } },
    } as OpenClawConfig;

    function makeWhatsAppContext(senderId: string): MsgContext {
      return channelContext("whatsapp", {
        From: `whatsapp:${senderId}`,
        SenderId: senderId,
      });
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
        commands: { allowFrom: { "*": ["globaluser"], whatsapp: ["+15551234567"] } },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const globalUserCtx = channelContext("whatsapp", {
        From: "whatsapp:globaluser",
        SenderId: "globaluser",
      });
      const globalAuth = authorize(globalUserCtx, cfg);
      expect(globalAuth.isAuthorizedSender).toBe(false);
      const whatsappUserCtx = channelContext("whatsapp", {
        From: "whatsapp:+15551234567",
        SenderE164: "+15551234567",
      });
      const whatsappAuth = authorize(whatsappUserCtx, cfg);
      expect(whatsappAuth.isAuthorizedSender).toBe(true);
    });

    it("requires owner identity before commands.allowFrom when the plugin enforces owner-only commands", () => {
      registerAllowFromPlugins(createOwnerEnforcingAllowFromPlugin("telegram", () => ["*"]));
      const cfg = {
        commands: { allowFrom: { "*": ["*"] } },
        channels: { telegram: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const auth = authorize(
        channelContext("telegram", {
          ChatType: "group",
          From: "telegram:999",
          SenderId: "999",
          CommandSource: "native",
        }),
        cfg,
      );
      expect(auth).toMatchObject({ senderIsOwner: false, isAuthorizedSender: false });
    });

    it("keeps commands.allowFrom available to non-owner command users when an owner allowlist is configured", () => {
      const cfg = {
        commands: { ownerAllowFrom: ["discord:owner"], allowFrom: { discord: ["helper"] } },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const auth = authorize(
        channelContext("discord", {
          ChatType: "group",
          From: "discord:helper",
          SenderId: "helper",
          CommandSource: "native",
        }),
        cfg,
      );
      expect(auth).toMatchObject({ senderIsOwner: false, isAuthorizedSender: true });
    });

    it.each([
      [
        "conversation ids are not senders",
        "discord",
        {
          ChatType: "channel",
          From: "discord:channel:123456789012345678",
          SenderId: "999999999999999999",
          SenderE164: undefined,
        },
        { discord: ["channel:123456789012345678"] },
        false,
      ],
      [
        "direct messages fall back to From",
        "discord",
        { ChatType: "direct", From: "discord:123456789012345678", SenderId: " ", SenderE164: " " },
        { discord: ["123456789012345678"] },
        true,
      ],
      [
        "missing chat type cannot authorize a conversation",
        "whatsapp",
        { ChatType: undefined, From: "demo:group:room-1", SenderId: " ", SenderE164: " " },
        { "*": ["demo:group:room-1"] },
        false,
      ],
    ] as const)("%s", (_name, provider, fields, allowFrom, expected) => {
      const auth = authorize(channelContext(provider, fields), { commands: { allowFrom } }, false);
      expect(auth.isAuthorizedSender).toBe(expected);
    });

    it.each([
      [
        "fails closed on unresolved allowlists",
        "telegram",
        "configured",
        false,
        false,
        "telegram",
        false,
      ],
      [
        "empty fallback preserves resolution errors",
        "telegram",
        "empty",
        false,
        true,
        undefined,
        false,
      ],
      [
        "unrelated provider errors do not poison allowFrom",
        "slack",
        "configured",
        true,
        false,
        "telegram",
        true,
      ],
    ] as const)(
      "%s",
      async (
        _name,
        failingProvider,
        channelMode,
        validTelegram,
        commandAuthorized,
        expectedProvider,
        expectedAuthorized,
      ) => {
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
            commands: { allowFrom: { telegram: ["123"] } },
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
      const auth = authorize(channelContext("telegram", { SenderId: "123" }), {
        channels: { telegram: { accounts: { default: { allowFrom: ["123"] } } } },
      } as OpenClawConfig);
      expect(auth.ownerList).toEqual([]);
      expect(auth).toMatchObject({ senderIsOwner: false, isAuthorizedSender: true });
    });

    it("does not log raw resolution messages from thrown allowFrom errors", () => {
      registerAllowFromPlugins(createThrowingAllowFromPlugin("telegram", "SECRET-TOKEN-123"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        authorize(channelContext("telegram", { SenderId: "123" }), {
          channels: { telegram: { allowFrom: ["123"] } },
        });
        expect(warn).toHaveBeenCalledTimes(1);
        const warning = String(warn.mock.calls[0]?.[0] ?? "");
        expect(warning).toContain("Error");
        expect(warning).not.toContain("SECRET-TOKEN-123");
      } finally {
        warn.mockRestore();
      }
    });
  });

  it.each([
    ["webchat", "operator.admin", true],
    ["webchat", "operator.approvals", false],
    ["telegram", "operator.admin", false],
  ] as const)("owner scope for %s with %s", (provider, scope, expectedOwner) => {
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

  it("requires slash for send policy", () => {
    expectCases(parseSendPolicyCommand, [
      ["/send on", { hasCommand: true, mode: "allow" }],
      ["/send: on", { hasCommand: true, mode: "allow" }],
      ["/send", { hasCommand: true }],
      ["/send:", { hasCommand: true }],
      ["send on", { hasCommand: false }],
      ["send", { hasCommand: false }],
    ]);
  });

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
    expect(hasControlCommand("/help@otherbot", undefined, { botUsername: "openclaw" })).toBe(false);
    expect(hasControlCommand("/help@openclaw", undefined, { botUsername: "openclaw" })).toBe(true);
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

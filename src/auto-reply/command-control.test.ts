import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MsgContext } from "./templating.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import { hasControlCommand, hasInlineCommandTokens } from "./command-detection.js";
import { listChatCommands } from "./commands-registry.js";
import { parseActivationCommand } from "./group-activation.js";
import { parseSendPolicyCommand } from "./send-policy.js";

const createRegistry = () =>
  createTestRegistry([
    {
      pluginId: "discord",
      plugin: createOutboundTestPlugin({ id: "discord", outbound: { deliveryMode: "direct" } }),
      source: "test",
    },
  ]);

beforeEach(() => {
  setActivePluginRegistry(createRegistry());
});

afterEach(() => {
  setActivePluginRegistry(createRegistry());
});

describe("resolveCommandAuthorization", () => {
  it("falls back from empty SenderId to SenderE164", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+123"] } },
    } as OpenClawConfig;

    const ctx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+999",
      SenderId: "",
      SenderE164: "+123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderId).toBe("+123");
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("falls back from whitespace SenderId to SenderE164", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+123"] } },
    } as OpenClawConfig;

    const ctx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+999",
      SenderId: "   ",
      SenderE164: "+123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderId).toBe("+123");
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("falls back to From when SenderId and SenderE164 are whitespace", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+999"] } },
    } as OpenClawConfig;

    const ctx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+999",
      SenderId: "   ",
      SenderE164: "   ",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderId).toBe("+999");
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("falls back from un-normalizable SenderId to SenderE164", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+123"] } },
    } as OpenClawConfig;

    const ctx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+999",
      SenderId: "wat",
      SenderE164: "+123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderId).toBe("+123");
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("prefers SenderE164 when SenderId does not match allowFrom", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+41796666864"] } },
    } as OpenClawConfig;

    const ctx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:120363401234567890@g.us",
      SenderId: "123@lid",
      SenderE164: "+41796666864",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderId).toBe("+41796666864");
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("uses explicit owner allowlist when allowFrom is wildcard", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["whatsapp:+15551234567"] },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    const ownerCtx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+15551234567",
      SenderE164: "+15551234567",
    } as MsgContext;
    const ownerAuth = resolveCommandAuthorization({
      ctx: ownerCtx,
      cfg,
      commandAuthorized: true,
    });
    expect(ownerAuth.senderIsOwner).toBe(true);
    expect(ownerAuth.isAuthorizedSender).toBe(true);

    const otherCtx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+19995551234",
      SenderE164: "+19995551234",
    } as MsgContext;
    const otherAuth = resolveCommandAuthorization({
      ctx: otherCtx,
      cfg,
      commandAuthorized: true,
    });
    expect(otherAuth.senderIsOwner).toBe(false);
    expect(otherAuth.isAuthorizedSender).toBe(false);
  });

  it("uses owner allowlist override from context when configured", () => {
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

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
    expect(auth.ownerList).toEqual(["123"]);
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

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.providerId).toBeUndefined();
    expect(auth.isAuthorizedSender).toBe(true);
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
      return resolveCommandAuthorization({
        ctx: makeWhatsAppContext(senderId),
        cfg: commandsAllowFromConfig,
        commandAuthorized,
      });
    }

    it("uses commands.allowFrom global list when configured", () => {
      const authorizedAuth = resolveWithCommandsAllowFrom("user123", true);

      expect(authorizedAuth.isAuthorizedSender).toBe(true);

      const unauthorizedAuth = resolveWithCommandsAllowFrom("otheruser", true);

      expect(unauthorizedAuth.isAuthorizedSender).toBe(false);
    });

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

      const globalAuth = resolveCommandAuthorization({
        ctx: globalUserCtx,
        cfg,
        commandAuthorized: true,
      });

      // Provider-specific list overrides global, so globaluser is not authorized
      expect(globalAuth.isAuthorizedSender).toBe(false);

      // User in whatsapp-specific list
      const whatsappUserCtx = {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:+15551234567",
        SenderE164: "+15551234567",
      } as MsgContext;

      const whatsappAuth = resolveCommandAuthorization({
        ctx: whatsappUserCtx,
        cfg,
        commandAuthorized: true,
      });

      expect(whatsappAuth.isAuthorizedSender).toBe(true);
    });

    it("falls back to channel allowFrom when commands.allowFrom not set", () => {
      const cfg = {
        channels: { whatsapp: { allowFrom: ["+15551234567"] } },
      } as OpenClawConfig;

      const authorizedCtx = {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:+15551234567",
        SenderE164: "+15551234567",
      } as MsgContext;

      const auth = resolveCommandAuthorization({
        ctx: authorizedCtx,
        cfg,
        commandAuthorized: true,
      });

      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("allows all senders when commands.allowFrom includes wildcard", () => {
      const cfg = {
        commands: {
          allowFrom: {
            "*": ["*"],
          },
        },
        channels: { whatsapp: { allowFrom: ["+specific"] } },
      } as OpenClawConfig;

      const anyUserCtx = {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:anyuser",
        SenderId: "anyuser",
      } as MsgContext;

      const auth = resolveCommandAuthorization({
        ctx: anyUserCtx,
        cfg,
        commandAuthorized: true,
      });

      expect(auth.isAuthorizedSender).toBe(true);
    });
  });
});

describe("control command parsing", () => {
  it("requires slash for send policy", () => {
    expect(parseSendPolicyCommand("/send on")).toEqual({
      hasCommand: true,
      mode: "allow",
    });
    expect(parseSendPolicyCommand("/send: on")).toEqual({
      hasCommand: true,
      mode: "allow",
    });
    expect(parseSendPolicyCommand("/send")).toEqual({ hasCommand: true });
    expect(parseSendPolicyCommand("/send:")).toEqual({ hasCommand: true });
    expect(parseSendPolicyCommand("send on")).toEqual({ hasCommand: false });
    expect(parseSendPolicyCommand("send")).toEqual({ hasCommand: false });
  });

  it("requires slash for activation", () => {
    expect(parseActivationCommand("/activation mention")).toEqual({
      hasCommand: true,
      mode: "mention",
    });
    expect(parseActivationCommand("/activation: mention")).toEqual({
      hasCommand: true,
      mode: "mention",
    });
    expect(parseActivationCommand("/activation:")).toEqual({
      hasCommand: true,
    });
    expect(parseActivationCommand("activation mention")).toEqual({
      hasCommand: false,
    });
  });

  it("treats bare commands as non-control", () => {
    expect(hasControlCommand("send")).toBe(false);
    expect(hasControlCommand("help")).toBe(false);
    expect(hasControlCommand("/commands")).toBe(true);
    expect(hasControlCommand("/commands:")).toBe(true);
    expect(hasControlCommand("commands")).toBe(false);
    expect(hasControlCommand("/status")).toBe(true);
    expect(hasControlCommand("/status:")).toBe(true);
    expect(hasControlCommand("status")).toBe(false);
    expect(hasControlCommand("usage")).toBe(false);

    for (const command of listChatCommands()) {
      for (const alias of command.textAliases) {
        expect(hasControlCommand(alias)).toBe(true);
        expect(hasControlCommand(`${alias}:`)).toBe(true);
      }
    }
    expect(hasControlCommand("/compact")).toBe(true);
    expect(hasControlCommand("/compact:")).toBe(true);
    expect(hasControlCommand("compact")).toBe(false);
  });

  it("respects disabled config/debug commands", () => {
    const cfg = { commands: { config: false, debug: false } };
    expect(hasControlCommand("/config show", cfg)).toBe(false);
    expect(hasControlCommand("/debug show", cfg)).toBe(false);
  });

  it("requires commands to be the full message", () => {
    expect(hasControlCommand("hello /status")).toBe(false);
    expect(hasControlCommand("/status please")).toBe(false);
    expect(hasControlCommand("prefix /send on")).toBe(false);
    expect(hasControlCommand("/send on")).toBe(true);
  });

  it("detects inline command tokens", () => {
    expect(hasInlineCommandTokens("hello /status")).toBe(true);
    expect(hasInlineCommandTokens("hey /think high")).toBe(true);
    expect(hasInlineCommandTokens("plain text")).toBe(false);
    expect(hasInlineCommandTokens("http://example.com/path")).toBe(false);
    expect(hasInlineCommandTokens("stop")).toBe(false);
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
});

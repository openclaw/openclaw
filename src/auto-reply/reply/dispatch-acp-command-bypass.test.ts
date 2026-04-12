import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import { buildTestCtx } from "./test-ctx.js";

describe("shouldBypassAcpDispatchForCommand", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("returns false for plain-text ACP turns", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      BodyForCommands: "write a test",
      BodyForAgent: "write a test",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns true for ACP slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp cancel",
      BodyForCommands: "/acp cancel",
      BodyForAgent: "/acp cancel",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for /unfocus in a bound conversation", () => {
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      CommandBody: "/unfocus",
      BodyForCommands: "/unfocus",
      BodyForAgent: "/unfocus",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for ACP reset-tail slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandSource: "native",
      CommandBody: "/new continue with deployment",
      BodyForCommands: "/new continue with deployment",
      BodyForAgent: "/new continue with deployment",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for bare ACP reset slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/reset",
      BodyForCommands: "/reset",
      BodyForAgent: "/reset",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns false for text slash commands on native command surfaces when text commands are disabled", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: createChannelTestPluginBase({
            id: "discord",
            capabilities: { nativeCommands: true, chatTypes: ["direct"] },
          }),
        },
      ]),
    );

    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp cancel",
      BodyForCommands: "/acp cancel",
      BodyForAgent: "/acp cancel",
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(false);
  });

  it("returns true for text slash commands on non-native command surfaces when text commands are disabled", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: createChannelTestPluginBase({
            id: "discord",
            capabilities: { nativeCommands: true, chatTypes: ["direct"] },
          }),
        },
      ]),
    );

    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandBody: "/acp cancel",
      BodyForCommands: "/acp cancel",
      BodyForAgent: "/acp cancel",
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(true);
  });

  it("returns false for unauthorized bang-prefixed commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "!poll",
      BodyForCommands: "!poll",
      BodyForAgent: "!poll",
      CommandAuthorized: false,
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns false for bang-prefixed commands when text commands are disabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "!poll",
      BodyForCommands: "!poll",
      BodyForAgent: "!poll",
      CommandAuthorized: true,
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(false);
  });

  it("returns true for authorized bang-prefixed commands when text commands are enabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "!poll",
      BodyForCommands: "!poll",
      BodyForAgent: "!poll",
      CommandAuthorized: true,
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        bash: true,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(true);
  });
});

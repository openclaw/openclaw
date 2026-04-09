import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import { buildTestCtx } from "./test-ctx.js";

function setDispatchBypassTestRegistry(params?: { discordNativeCommands?: boolean }): void {
  if (!params?.discordNativeCommands) {
    setActivePluginRegistry(createTestRegistry([]));
    return;
  }
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: createChannelTestPluginBase({
          id: "discord",
          label: "Discord",
          capabilities: { nativeCommands: true, chatTypes: ["direct"] },
        }),
      },
    ]),
  );
}

describe("shouldBypassAcpDispatchForCommand", () => {
  beforeEach(() => {
    setDispatchBypassTestRegistry();
  });

  afterEach(() => {
    setDispatchBypassTestRegistry();
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

  it("returns true for /acp slash commands when allowTextCommands resolves to true", () => {
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

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(true);
  });

  it("returns false for /acp slash commands when allowTextCommands resolves to false", () => {
    setDispatchBypassTestRegistry({ discordNativeCommands: true });

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

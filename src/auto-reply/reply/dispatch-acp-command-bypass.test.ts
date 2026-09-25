// Tests ACP command bypass detection before normal dispatch.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import { buildTestCtx } from "./test-ctx.js";

function commandContext(command: string, overrides: Parameters<typeof buildTestCtx>[0] = {}) {
  return buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    CommandBody: command,
    BodyForCommands: command,
    BodyForAgent: command,
    ...overrides,
  });
}

describe("shouldBypassAcpDispatchForCommand", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("returns false for plain-text ACP turns", () => {
    expect(shouldBypassAcpDispatchForCommand(commandContext("write a test"), {})).toBe(false);
  });

  it.each([
    { command: "/acp@otherbot cancel", expected: false },
    { command: "/status", expected: true },
    { command: "/v off", expected: true },
    { command: "/reset", expected: true },
  ])("returns $expected for $command", ({ command, expected }) => {
    expect(shouldBypassAcpDispatchForCommand(commandContext(command), {})).toBe(expected);
  });

  it("prefers clean command text over channel envelopes", () => {
    const ctx = commandContext("/status", {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandBody: "[WhatsApp +15551234567 +1m Fri 2026-05-08 16:12 UTC] /status",
    });
    expect(shouldBypassAcpDispatchForCommand(ctx, {})).toBe(true);
  });

  it("returns true for a colon-form local verbose alias", () => {
    expect(shouldBypassAcpDispatchForCommand(commandContext("/v:off"), {})).toBe(true);
  });

  it("returns true for ACP reset-tail slash commands", () => {
    const ctx = commandContext("/new continue with deployment", { CommandSource: "native" });
    expect(shouldBypassAcpDispatchForCommand(ctx, {})).toBe(true);
  });

  it("returns true for ACP slash commands when text commands are disabled", () => {
    const ctx = commandContext("/acp cancel", { CommandSource: "text" });
    expect(shouldBypassAcpDispatchForCommand(ctx, { commands: { text: false } })).toBe(true);
  });

  it("returns false for local status commands when text commands are disabled on text-native surfaces", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: createChannelTestPluginBase({
            id: "discord",
            capabilities: { nativeCommands: true, chatTypes: ["direct"] },
          }),
          source: "test",
        },
      ]),
    );
    const ctx = commandContext("/status", { CommandSource: "text" });
    expect(shouldBypassAcpDispatchForCommand(ctx, { commands: { text: false } })).toBe(false);
  });

  it("returns true for native local status commands when text commands are disabled", () => {
    const ctx = commandContext("/status", { CommandSource: "native" });
    expect(shouldBypassAcpDispatchForCommand(ctx, { commands: { text: false } })).toBe(true);
  });

  it("returns false for unauthorized bang-prefixed commands", () => {
    const ctx = commandContext("!poll", { CommandAuthorized: false });
    expect(shouldBypassAcpDispatchForCommand(ctx, {})).toBe(false);
  });

  it("returns false for bang-prefixed commands when text commands are disabled", () => {
    const ctx = commandContext("!poll", { CommandAuthorized: true, CommandSource: "text" });
    expect(shouldBypassAcpDispatchForCommand(ctx, { commands: { text: false } })).toBe(false);
  });

  it("returns true for authorized bang-prefixed commands when text commands are enabled", () => {
    const ctx = commandContext("!poll", { CommandAuthorized: true, CommandSource: "text" });
    expect(shouldBypassAcpDispatchForCommand(ctx, { commands: { bash: true } })).toBe(true);
  });
});

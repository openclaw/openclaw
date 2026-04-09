import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import { buildTestCtx } from "./test-ctx.js";

describe("shouldBypassAcpDispatchForCommand", () => {
  it("returns false for plain-text ACP turns", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      BodyForCommands: "write a test",
      BodyForAgent: "write a test",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns false for ACP slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp cancel",
      BodyForCommands: "/acp cancel",
      BodyForAgent: "/acp cancel",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns false for ACP reset-tail slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandSource: "native",
      CommandBody: "/new continue with deployment",
      BodyForCommands: "/new continue with deployment",
      BodyForAgent: "/new continue with deployment",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns false for slash commands when text commands are disabled", () => {
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

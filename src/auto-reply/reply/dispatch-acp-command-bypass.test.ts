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

  it("returns true for /acp slash commands — regression for #66298", () => {
    // /acp text commands sent inside a thread bound to an ACP session must
    // bypass the ACP dispatch so they reach handleAcpCommand. Otherwise the
    // ACP agent consumes them as conversational input and the session stays
    // open regardless of what the user typed.
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp close",
      BodyForCommands: "/acp close",
      BodyForAgent: "/acp close",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for /acp slash commands via native command source", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandSource: "native",
      CommandBody: "/acp status",
      BodyForCommands: "/acp status",
      BodyForAgent: "/acp status",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for /acp slash commands even when text commands are disabled", () => {
    // /acp is a session-management command (close/cancel/status/…), mirroring
    // /new and /reset. It must bypass the ACP dispatch even when the surface
    // has commands.text = false — otherwise the user has no way to close a
    // runaway ACP session short of hand-editing thread-bindings.json.
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp close",
      BodyForCommands: "/acp close",
      BodyForAgent: "/acp close",
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(true);
  });

  it("returns false for unrecognized slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/foo cancel",
      BodyForCommands: "/foo cancel",
      BodyForAgent: "/foo cancel",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
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

  it("returns false for unrecognized slash commands when text commands are disabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/foo cancel",
      BodyForCommands: "/foo cancel",
      BodyForAgent: "/foo cancel",
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
